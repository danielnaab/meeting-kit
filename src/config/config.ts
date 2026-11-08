/**
 * meeting-kit.yaml: what a consuming repository tells the kit about itself.
 *
 * The kit is content-neutral. Everything that names a person, an organization, a calendar, a server, or a deployment
 * lives in the consuming repository's `meeting-kit.yaml` (this module reads and validates it) and in the instruction
 * appendices it points to. Two readers:
 *
 *   - the runner, at run time, from its fresh clone of the repository: owner, organization, identity, agents,
 *     instructions (so a config change reaches the next run with the content, at the same commit);
 *   - `meeting-kit render`, at authoring time, into the repository's committed `windmill/` tree: timezone, calendar,
 *     mcp, windmill.
 *
 * `version` is the config's own major version. A kit release that changes the shape incompatibly bumps it and says
 * how to migrate in CHANGELOG.md (graft's convention). Unknown keys are errors, so a typo never silently does nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "meeting-kit.yaml";
export const CONFIG_VERSION = 1;
export const AGENTS = ["meeting-synthesis", "meeting-triage", "meeting-briefing"] as const;
export type AgentName = (typeof AGENTS)[number];

export interface McpServer {
  url: string;
}

export interface MeetingKitConfig {
  version: 1;
  /** The person whose work the vault holds: `name` in full, `short` as the instructions address them. */
  owner: { name: string; short: string };
  /** Whose work this is ("Example Co"): the instructions keep the vault to it. */
  organization: string;
  /** IANA zone the agents' "today" and the schedules use. */
  timezone: string;
  /** The agents this repository runs (default: all). */
  agents: AgentName[];
  /** Commit author and committer of the agents' commits. */
  identity: { name: string; email: string };
  /** Per-agent Markdown, relative to the repository root, appended to the kit's instructions. */
  instructions: Partial<Record<AgentName, string>>;
  /** The calendar the briefings read (an id the calendar MCP server understands). */
  calendar: { id: string };
  /**
   * MCP servers the agents may be given, by the key an agent asks for (calendar, contacts, records). Each gets the
   * header `apiKey.header: ${<apiKey.env>}`; the value is read from the Windmill variable `apiKey.variable`.
   */
  mcp: {
    servers: Record<string, McpServer>;
    apiKey: { header: string; variable: string; env: string };
  };
  windmill: WindmillConfig;
}

export interface WindmillConfig {
  /** The folder the rendered tree is pushed to: f/<folder>/. Its variables live there too. */
  folder: string;
  /** Where the agent worker mounts the repository's checkout (read-only). */
  mount: string;
  /** claude's config dir under the worker's persistent home. */
  claudeConfigDir: string;
  /** Six-field Windmill cron expressions, in `timezone`. */
  schedules: { synthesis: string; workdayStart: string };
  /** Push-triggered synthesis: an HTTP route for a Forgejo push webhook. Absent: schedule only. */
  webhook?: { route: string; signatureHeader: string };
}

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Reader {
  errors: string[] = [];
  obj(v: unknown, path: string, keys: string[]): Obj {
    if (!isObj(v)) {
      this.errors.push(`${path}: must be a mapping`);
      return {};
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) this.errors.push(`${path}.${k}: unknown key`);
    return v;
  }
  str(o: Obj, key: string, path: string, opts: { pattern?: RegExp; hint?: string; fallback?: string } = {}): string {
    const v = o[key];
    if (v === undefined && opts.fallback !== undefined) return opts.fallback;
    if (typeof v !== "string" || !v.trim()) {
      this.errors.push(`${path}.${key}: must be a non-empty string`);
      return "";
    }
    if (opts.pattern && !opts.pattern.test(v)) this.errors.push(`${path}.${key}: ${opts.hint ?? `must match ${opts.pattern}`}`);
    return v;
  }
}

const CRON6 = /^\S+( \S+){5}$/;

/** Validate a parsed meeting-kit.yaml. Throws ConfigError listing every problem. */
export function parseConfig(raw: unknown, source = CONFIG_FILE): MeetingKitConfig {
  const r = new Reader();
  const top = r.obj(raw, source, [
    "version", "owner", "organization", "timezone", "agents", "identity", "instructions", "calendar", "mcp", "windmill",
  ]);
  if (top.version !== CONFIG_VERSION) {
    r.errors.push(`${source}.version: must be ${CONFIG_VERSION} (this kit reads version ${CONFIG_VERSION})`);
  }
  const owner = r.obj(top.owner, `${source}.owner`, ["name", "short"]);
  const identity = r.obj(top.identity, `${source}.identity`, ["name", "email"]);
  const calendar = r.obj(top.calendar, `${source}.calendar`, ["id"]);
  const mcp = r.obj(top.mcp, `${source}.mcp`, ["servers", "apiKey"]);
  const servers = r.obj(mcp.servers, `${source}.mcp.servers`, Object.keys(isObj(mcp.servers) ? mcp.servers : {}));
  const apiKey = r.obj(mcp.apiKey, `${source}.mcp.apiKey`, ["header", "variable", "env"]);
  const wm = r.obj(top.windmill, `${source}.windmill`, ["folder", "mount", "claudeConfigDir", "schedules", "webhook"]);
  const schedules = r.obj(wm.schedules, `${source}.windmill.schedules`, ["synthesis", "workdayStart"]);

  let agents: AgentName[] = [...AGENTS];
  if (top.agents !== undefined) {
    if (!Array.isArray(top.agents) || top.agents.some((a) => !(AGENTS as readonly unknown[]).includes(a))) {
      r.errors.push(`${source}.agents: must be a list of ${AGENTS.join(", ")}`);
    } else agents = top.agents as AgentName[];
  }

  const instructions: Partial<Record<AgentName, string>> = {};
  if (top.instructions !== undefined) {
    const ins = r.obj(top.instructions, `${source}.instructions`, [...AGENTS]);
    for (const [k, v] of Object.entries(ins)) {
      if (typeof v !== "string" || !v.trim() || v.startsWith("/") || v.split("/").includes("..")) {
        r.errors.push(`${source}.instructions.${k}: must be a path inside the repository`);
      } else instructions[k as AgentName] = v;
    }
  }

  const serverMap: Record<string, McpServer> = {};
  for (const [k, v] of Object.entries(servers)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(k)) r.errors.push(`${source}.mcp.servers.${k}: key must be [a-z][a-z0-9_-]*`);
    const s = r.obj(v, `${source}.mcp.servers.${k}`, ["url"]);
    serverMap[k] = { url: r.str(s, "url", `${source}.mcp.servers.${k}`, { pattern: /^https?:\/\//, hint: "must be an http(s) URL" }) };
  }

  let webhook: WindmillConfig["webhook"];
  if (wm.webhook !== undefined) {
    const w = r.obj(wm.webhook, `${source}.windmill.webhook`, ["route", "signatureHeader"]);
    webhook = {
      route: r.str(w, "route", `${source}.windmill.webhook`, { pattern: /^[a-z0-9][a-z0-9_/-]*$/, hint: "must be a route path like my-vault/meeting-push" }),
      signatureHeader: r.str(w, "signatureHeader", `${source}.windmill.webhook`, { fallback: "X-Forgejo-Signature" }),
    };
  }

  const config: MeetingKitConfig = {
    version: 1,
    owner: { name: r.str(owner, "name", `${source}.owner`), short: r.str(owner, "short", `${source}.owner`) },
    organization: r.str(top, "organization", source),
    timezone: r.str(top, "timezone", source, { pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/, hint: "must be an IANA zone like America/Chicago" }),
    agents,
    identity: {
      name: r.str(identity, "name", `${source}.identity`),
      email: r.str(identity, "email", `${source}.identity`, { pattern: /^[^@\s]+@[^@\s]+$/, hint: "must be an email address" }),
    },
    instructions,
    calendar: { id: r.str(calendar, "id", `${source}.calendar`) },
    mcp: {
      servers: serverMap,
      apiKey: {
        header: r.str(apiKey, "header", `${source}.mcp.apiKey`),
        variable: r.str(apiKey, "variable", `${source}.mcp.apiKey`, { pattern: /^[a-z0-9_]+$/, hint: "must be a variable name under the folder, [a-z0-9_]" }),
        env: r.str(apiKey, "env", `${source}.mcp.apiKey`, { pattern: /^[A-Z][A-Z0-9_]*$/, hint: "must be an environment variable name" }),
      },
    },
    windmill: {
      folder: r.str(wm, "folder", `${source}.windmill`, { pattern: /^[a-z0-9_]+$/, hint: "must be a Windmill folder name, [a-z0-9_]" }),
      mount: r.str(wm, "mount", `${source}.windmill`, { pattern: /^\/\S+$/, hint: "must be an absolute path" }),
      claudeConfigDir: r.str(wm, "claudeConfigDir", `${source}.windmill`, { pattern: /^[\w.-]+$/, hint: "must be a directory name" }),
      schedules: {
        synthesis: r.str(schedules, "synthesis", `${source}.windmill.schedules`, { pattern: CRON6, hint: "must be a six-field cron expression" }),
        workdayStart: r.str(schedules, "workdayStart", `${source}.windmill.schedules`, { pattern: CRON6, hint: "must be a six-field cron expression" }),
      },
      ...(webhook ? { webhook } : {}),
    },
  };
  if (r.errors.length) throw new ConfigError(`invalid ${source}:\n  ${r.errors.join("\n  ")}`);
  return config;
}

/** Read and validate <root>/meeting-kit.yaml. */
export function loadConfig(root: string): MeetingKitConfig {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new ConfigError(`${CONFIG_FILE} is missing at ${root}: a repository that uses meeting-kit describes itself there (see the kit's docs/config.md)`);
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
