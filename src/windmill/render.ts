/**
 * `meeting-kit render [--root DIR] [--check]`: the kit's Windmill templates (windmill/f/meeting_kit/ in the kit),
 * filled from the repository's meeting-kit.yaml, written into the repository's own committed windmill/ tree:
 *
 *   <root>/windmill/f/<windmill.folder>/   kit-owned: regenerated wholesale, stale files removed
 *   <root>/windmill/README.md               kit-owned: says it is generated, and what the host must provide
 *
 * Everything else under <root>/windmill/ (wmill-lock.yaml, other folders) is left alone. The host pushes
 * f/<folder>/ from its checkout as it is, so a kit upgrade reaches Windmill only as a reviewed, committed diff.
 * `--check` changes nothing: it lists the drift and exits 1, for the repository's own checks.
 *
 * The rendering is src/render/tree.ts (generic). This module is the meeting-specific half: which config value goes
 * into which placeholder, and which files belong to an optional feature.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, loadConfig, type MeetingKitConfig } from "../config/config.ts";
import { drift, fill, renderTemplates, TemplateError, writeTree, type Files } from "../render/tree.ts";

/** The kit's windmill/ directory: templates under f/meeting_kit/, the README template beside them. */
export const KIT_WINDMILL = join(import.meta.dir, "../../windmill");
/** The folder name the templates are written for; rendering replaces `f/meeting_kit/` with `f/<folder>/`. */
export const TEMPLATE_FOLDER = "meeting_kit";
export const README_TEMPLATE = "README.template.md";

/** Template files (paths under f/meeting_kit/) that only exist when `windmill.webhook` is set. */
const WEBHOOK_FILES = [
  "meeting_synthesis/on_push.flow/",
  "meeting_synthesis/on_push.http_trigger.yaml",
  "meeting_synthesis/webhook_auth.resource.yaml",
  "shared/push.ts",
  "shared/push.script.yaml",
];

/**
 * Plain values land inside double-quoted YAML, TS and shell strings, verbatim. Rather than escape for three
 * languages, refuse what any of them would read as more than text.
 */
const PLAIN = /^[^"'\\$`{}\n\r]*$/;
/** Environment names run.sh itself sets or clears: the MCP key must not take one over. */
const RESERVED_ENV = /^(PATH|HOME|TZ|SHELL|IFS|USER|LANG|BASH.*|LD_.*|WM_.*|BASE_.*|CLAUDE_.*|ANTHROPIC_.*|GIT_.*|MEETING_KIT_.*)$/;

/** The placeholder values, from a validated config. Throws ConfigError for a value the templates can't carry. */
export function templateValues(config: MeetingKitConfig): Record<string, string> {
  const errors: string[] = [];
  const { mcp, windmill } = config;
  const calendarServer = mcp.servers.calendar;
  if (!calendarServer) errors.push("mcp.servers.calendar: the workday_start calendar gate needs a calendar server");
  if (!/^[A-Za-z0-9-]+$/.test(mcp.apiKey.header)) errors.push("mcp.apiKey.header: must be an HTTP header name");
  if (RESERVED_ENV.test(mcp.apiKey.env)) errors.push(`mcp.apiKey.env: ${mcp.apiKey.env} is set by the runner script itself; pick another name`);

  const plain: [string, string, string][] = [
    ["folder", windmill.folder, "windmill.folder"],
    ["timezone", config.timezone, "timezone"],
    ["calendar_id", config.calendar.id, "calendar.id"],
    ["calendar_mcp_url", calendarServer?.url ?? "", "mcp.servers.calendar.url"],
    ["schedule_synthesis", windmill.schedules.synthesis, "windmill.schedules.synthesis"],
    ["schedule_workday_start", windmill.schedules.workdayStart, "windmill.schedules.workdayStart"],
    ["mount", windmill.mount, "windmill.mount"],
    ["claude_config_dir", windmill.claudeConfigDir, "windmill.claudeConfigDir"],
    ["api_key_header", mcp.apiKey.header, "mcp.apiKey.header"],
    ["api_key_env", mcp.apiKey.env, "mcp.apiKey.env"],
    ["api_key_variable", mcp.apiKey.variable, "mcp.apiKey.variable"],
  ];
  if (windmill.webhook) {
    plain.push(["webhook_route", windmill.webhook.route, "windmill.webhook.route"]);
    plain.push(["webhook_signature_header", windmill.webhook.signatureHeader, "windmill.webhook.signatureHeader"]);
  }
  for (const [, value, key] of plain) if (!PLAIN.test(value)) errors.push(`${key}: must not contain quotes, backslashes, $, backticks, braces or newlines`);
  if (errors.length) throw new ConfigError(`meeting-kit.yaml can't be rendered:\n  ${errors.join("\n  ")}`);

  // claude's MCP config: every server, the key header as a reference claude expands from its environment. It goes
  // into a quoted heredoc in run.sh, so it is the one value that may hold quotes and `$`.
  const servers = Object.fromEntries(Object.entries(mcp.servers).map(([name, s]) => [
    name, { type: "http", url: s.url, headers: { [mcp.apiKey.header]: `\${${mcp.apiKey.env}}` } },
  ]));
  return {
    ...Object.fromEntries(plain.map(([name, value]) => [name, value])),
    mcp_servers_json: JSON.stringify({ mcpServers: servers }, null, 2),
  };
}

/** The rendered tree, by path under the repository's windmill/ directory. */
export function renderTree(config: MeetingKitConfig, kitWindmillDir: string = KIT_WINDMILL): Files {
  const folder = config.windmill.folder;
  const spec = { replace: [[`f/${TEMPLATE_FOLDER}/`, `f/${folder}/`]] as [string, string][], values: templateValues(config) };
  const files = renderTemplates(join(kitWindmillDir, "f", TEMPLATE_FOLDER), spec, {
    include: (rel) => config.windmill.webhook !== undefined || !WEBHOOK_FILES.some((w) => (w.endsWith("/") ? rel.startsWith(w) : rel === w)),
    rename: (rel) => `f/${folder}/${rel}`,
  });
  files.set("README.md", fill(readFileSync(join(kitWindmillDir, README_TEMPLATE), "utf8"), spec, README_TEMPLATE));
  return files;
}

export interface RenderDeps {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  kitWindmillDir?: string;
}

const USAGE = "usage: meeting-kit render [--root DIR] [--check]";

/** The CLI. Exit codes: 0 rendered (or no drift), 1 drift (--check), 2 bad arguments or config. */
export async function main(argv: string[], deps: RenderDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const args = argv[0] === "render" ? argv.slice(1) : [...argv];
  let root = deps.cwd ?? process.cwd();
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--check") check = true;
    else if (a === "--root" && args[i + 1]) root = resolve(root, args[++i]!);
    else if (a.startsWith("--root=")) root = resolve(root, a.slice("--root=".length));
    else {
      err(`unexpected argument ${a}\n${USAGE}`);
      return 2;
    }
  }

  let files: Files;
  let config: MeetingKitConfig;
  try {
    config = loadConfig(root);
    files = renderTree(config, deps.kitWindmillDir);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof TemplateError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  const outDir = join(root, "windmill");
  const owned = [`f/${config.windmill.folder}/`, "README.md"];

  if (check) {
    const lines = drift(outDir, owned, files);
    if (lines.length === 0) return 0;
    err(`windmill/ differs from what meeting-kit.yaml and the kit render:\n  ${lines.join("\n  ")}\nRun \`meeting-kit render\` and commit the result.`);
    return 1;
  }
  const { written, removed } = writeTree(outDir, owned, files);
  out(`rendered ${written.length} files into windmill/ (f/${config.windmill.folder}/, README.md)`);
  for (const p of removed) out(`removed ${p}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
