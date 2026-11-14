// agent/run.sh, the Windmill adapter for `meeting-kit run`, as rendered from examples/meeting-kit.yaml, run against
// stand-ins: curl answers Windmill's variables API with fake values, git and claude only record, a directory plays
// the checkout the host mounts, and a fake `meeting-kit` in its .local/tools/bin plays the runner. No network, no
// real secrets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config, F, FOLDER } from "./rendered.ts";

/** Stubs name bash by its path: the Nix build sandbox (nix flake check) has no /usr/bin/env. */
const BASH = Bun.which("bash")!;

const SCRIPT = `${F}/agent/run.sh`;
const API_KEY_ENV = config.mcp.apiKey.env;

const VARIABLES: Record<string, string> = {
  repo_deploy_key: "FAKE-DEPLOY-KEY",
  known_hosts: "[172.17.0.1]:2222 ssh-rsa FAKEHOSTKEY",
  repo_url: "ssh://git@172.17.0.1:2222/alex/example-vault.git",
  [config.mcp.apiKey.variable]: "fake-mcp-key",
  claude_oauth_token: "fake-oauth-token",
};

let dir: string;
let job: string;
let stubs: string;
let checkout: string;
let tools: string;
let home: string;

function stub(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${BASH}\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The runner stand-in: records its argv, environment and what it could see, then prints `summary` and exits `code`. */
function fakeRunner(summary: object | null, code = 0, extraStdout = "") {
  stub(join(tools, "meeting-kit"), `
printf '%s\\n' "$@" > "${dir}/runner.args"
env > "${dir}/runner.env"
[ -e "$PWD/deploy_key" ] && echo yes > "${dir}/runner.saw-key"
for a in "$@"; do case "$prev" in --mcp-config) cp "$a" "${dir}/mcp.json" ;; esac; prev="$a"; done
${extraStdout ? `printf '%s\\n' ${JSON.stringify(extraStdout)}` : ""}
${summary ? `printf '%s\\n' '${JSON.stringify(summary)}'` : ""}
echo "runner log line" >&2
exit ${code}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-sh-test-"));
  job = join(dir, "job");
  stubs = join(dir, "stubs");
  checkout = join(dir, "checkout");
  tools = join(checkout, ".local/tools/bin");
  home = join(dir, "home");
  mkdirSync(job);
  mkdirSync(home);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "meeting-kit.yaml"), "version: 1\n");
  stub(join(stubs, "curl"), `
echo "curl" >> "${dir}/curl.log"
for a in "$@"; do url="$a"; done
case "$*" in *"Authorization: Bearer job-token"*) ;; *) echo "no token" >&2; exit 22 ;; esac
name="\${url##*/variables/get_value/f/${FOLDER}/}"
case "$name" in
${Object.entries(VARIABLES).map(([k, v]) => `  ${k}) printf '%s' '${JSON.stringify(v)}' ;;`).join("\n")}
  *) echo "404 $name" >&2; exit 22 ;;
esac`);
  stub(join(stubs, "git"), `
echo "git $*" >> "${dir}/git.log"
case "$*" in *" rev-parse "*) echo abc1234 ;; esac
exit 0`);
  stub(join(stubs, "claude"), `
case "$1" in
  --version) echo "2.1.0 (Claude Code)" ;;
  update) echo "claude update" >> "${dir}/claude.log" ;;
esac`);
  for (const name of ["nb-index", "check-kb", "check-tasks"]) stub(join(tools, name), `echo "${name} $*" >> "${dir}/tools.log"`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}) {
  // The system tools run.sh needs, without nix: on NixOS they share /run/current-system/sw/bin with it.
  const system = join(dir, "system-bin");
  if (!existsSync(system)) {
    mkdirSync(system);
    for (const d of new Set(["bash", "jq", "timeout", "sed", "awk"].map((c) => dirname(Bun.which(c)!))))
      for (const f of readdirSync(d))
        if (!/^nix(-|$)/.test(f) && !existsSync(join(system, f))) symlinkSync(join(d, f), join(system, f));
  }
  const path = [stubs, system].join(":");
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: job,
    env: {
      PATH: path,
      WM_TOKEN: "job-token",
      WM_WORKSPACE: "homelab",
      WM_JOB_ID: "job-1",
      BASE_INTERNAL_URL: "http://windmill.invalid",
      ANTHROPIC_API_KEY: "must-not-reach-claude",
      MEETING_KIT_RUN_HOME: home,
      MEETING_KIT_CODE: checkout,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const readEnv = () =>
  Object.fromEntries(
    readFileSync(join(dir, "runner.env"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

const ok = { agent: "meeting-synthesis", status: "pushed", created: ["notebook/records/meetings/2026-11/a.md"], cost: 0.2, output: null };

describe("run.sh", () => {
  test("runs the runner from the mounted checkout, and the job's result is its summary", async () => {
    fakeRunner(ok);
    const r = await run(["meeting-synthesis"]);
    expect(r.code, r.stderr).toBe(0);
    const args = readFileSync(join(dir, "runner.args"), "utf8").trim().split("\n");
    expect(args).toEqual(["run", "meeting-synthesis", "--mcp-config", join(job, "mcp.json")]);
    // The commit comes from the checkout; the job clones nothing itself (the runner makes its own clone of the vault).
    const git = readFileSync(join(dir, "git.log"), "utf8");
    expect(git).toContain(`-C ${checkout} rev-parse --short HEAD`);
    expect(git).not.toContain("clone");
    const result = JSON.parse(readFileSync(join(job, "result.json"), "utf8"));
    expect(result).toEqual({ ...ok, commit: "abc1234", claude: "2.1.0", wm_labels: ["agent:meeting-synthesis", "status:pushed"] });
    expect(readFileSync(join(dir, "claude.log"), "utf8")).toContain("claude update");
  });

  test("gives the runner the remote, the key for clone and push, the MCP key and the Claude token, and nothing of Windmill's", async () => {
    fakeRunner(ok);
    await run(["meeting-synthesis"]);
    const env = readEnv();
    expect(env.MEETING_KIT_REMOTE).toBe(VARIABLES.repo_url);
    expect(env[API_KEY_ENV]).toBe(VARIABLES[config.mcp.apiKey.variable]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(VARIABLES.claude_oauth_token);
    expect(env.TZ).toBe(config.timezone);
    expect(env.HOME).toBe(home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, config.windmill.claudeConfigDir));
    // The commit's author is the runner's (meeting-kit.yaml identity), not this script's.
    for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) expect(env[name], name).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toContain(`-i ${join(job, "deploy_key")}`);
    expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    for (const name of ["WM_TOKEN", "WM_WORKSPACE", "WM_JOB_ID", "BASE_INTERNAL_URL", "ANTHROPIC_API_KEY"]) expect(env[name], name).toBeUndefined();
    expect(env.MEETING_KIT_TOOLS).toBe(tools);
    expect(env.MEETING_KIT_CODE).toBeUndefined();
    expect(env.MEETING_KIT_RUN_HOME).toBeUndefined();
    expect(env.PATH!.split(":")[0]).toBe(tools);
    expect(readFileSync(join(dir, "runner.saw-key"), "utf8").trim()).toBe("yes");
  });

  test("the deploy key does not outlive the job, on success or failure", async () => {
    fakeRunner(ok);
    await run(["meeting-synthesis"]);
    expect(existsSync(join(job, "deploy_key"))).toBe(false);
    fakeRunner({ ...ok, status: "failed", error: "model failed" }, 1);
    await run(["meeting-synthesis"]);
    expect(existsSync(join(job, "deploy_key"))).toBe(false);
  });

  test("the MCP config names the configured servers and holds no secret, only a reference", async () => {
    fakeRunner(ok);
    await run(["meeting-briefing", '{"date":"2026-11-09","title":"Sprint review"}']);
    const text = readFileSync(join(dir, "mcp.json"), "utf8");
    expect(text).not.toContain(VARIABLES[config.mcp.apiKey.variable]);
    const mcp = JSON.parse(text);
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(Object.keys(config.mcp.servers).sort());
    for (const [name, server] of Object.entries<any>(mcp.mcpServers)) {
      expect(server.type).toBe("http");
      expect(server.url).toBe(config.mcp.servers[name]!.url);
      expect(server.headers).toEqual({ [config.mcp.apiKey.header]: `\${${API_KEY_ENV}}` });
    }
  });

  test("passes the input and dry_run through", async () => {
    fakeRunner({ ...ok, agent: "meeting-briefing", status: "dry-run" }, 0, "prompt:\nWrite the briefing");
    const r = await run(["meeting-briefing", '{"date":"2026-11-09","title":"Sprint review"}', "true"]);
    expect(r.code, r.stderr).toBe(0);
    const args = readFileSync(join(dir, "runner.args"), "utf8").trim().split("\n");
    expect(args.slice(1)).toEqual(["meeting-briefing", "--mcp-config", join(job, "mcp.json"), "--dry-run", "--input", '{"date":"2026-11-09","title":"Sprint review"}']);
    // The dry run's prompt goes to the job log, not into the result.
    expect(r.stderr).toContain("Write the briefing");
    expect(JSON.parse(readFileSync(join(job, "result.json"), "utf8")).status).toBe("dry-run");
  });

  test("a structured answer reaches the result as `output`, for the next flow step", async () => {
    const triage = { agent: "meeting-triage", status: "no-changes", created: [], cost: 0.05, output: { meetings: [{ uid: "u1" }], skipped: [] } };
    fakeRunner(triage);
    await run(["meeting-triage", '{"date":"2026-11-09","meetings":[{"uid":"u1"}]}']);
    expect(JSON.parse(readFileSync(join(job, "result.json"), "utf8")).output).toEqual(triage.output);
  });

  test("notices reach the result", async () => {
    fakeRunner({ ...ok, notices: ["Not synthesized, judged not a work meeting: x"] });
    await run(["meeting-synthesis"]);
    expect(JSON.parse(readFileSync(join(job, "result.json"), "utf8")).notices).toEqual(["Not synthesized, judged not a work meeting: x"]);
  });

  test("a failed run fails the job, and its last log line says why", async () => {
    fakeRunner({ ...ok, status: "failed", error: "nix run .#check-kb failed (exit 1):\nbroken link" }, 1);
    const r = await run(["meeting-synthesis"]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split("\n").slice(-2)).toEqual(["meeting-kit: meeting-synthesis failed: nix run .#check-kb failed (exit 1):", "broken link"]);
    expect(existsSync(join(job, "result.json"))).toBe(false);
  });

  test("a runner that prints no summary fails the job", async () => {
    fakeRunner(null, 2);
    const r = await run(["meeting-synthesis"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("printed no summary");
  });

  test("a variable it cannot read fails the job before the runner starts", async () => {
    fakeRunner(ok);
    for (const name of Object.keys(VARIABLES)) {
      stub(join(stubs, "curl"), `
for a in "$@"; do url="$a"; done
case "$url" in */${name}) echo "404" >&2; exit 22 ;; esac
printf '%s' '"value"'`);
      const r = await run(["meeting-synthesis"]);
      expect(r.code, name).not.toBe(0);
      expect(existsSync(join(dir, "runner.args")), name).toBe(false);
    }
  });

  test("bad arguments stop before any secret is read", async () => {
    for (const args of [["Meeting Synthesis"], [""], ["meeting-synthesis", "", "maybe"]]) {
      const r = await run(args);
      expect(r.code, args.join(",")).toBe(2);
    }
    expect(existsSync(join(dir, "git.log"))).toBe(false);
  });

  test("there is no nix stand-in: the runner runs the checks from MEETING_KIT_TOOLS", async () => {
    stub(join(tools, "meeting-kit"), `"$MEETING_KIT_TOOLS/nb-index"; "$MEETING_KIT_TOOLS/check-kb"; "$MEETING_KIT_TOOLS/check-tasks"
command -v nix > "${dir}/nix.path" || true
printf '%s\\n' '${JSON.stringify(ok)}'`);
    const r = await run(["meeting-synthesis"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "tools.log"), "utf8").trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["nb-index", "check-kb", "check-tasks"]);
    expect(readFileSync(join(dir, "nix.path"), "utf8")).toBe("");
    expect(existsSync(join(job, "bin/nix"))).toBe(false);
  });

  test("a missing checkout fails the job clearly, before any secret is read", async () => {
    fakeRunner(ok);
    const r = await run(["meeting-synthesis"], { MEETING_KIT_CODE: join(dir, "nowhere") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${join(dir, "nowhere")}/meeting-kit.yaml is missing`);
    expect(existsSync(join(dir, "curl.log"))).toBe(false);
    expect(existsSync(join(dir, "runner.args"))).toBe(false);
  });

  test("missing tools fail the job clearly, before any secret is read, dry run or not", async () => {
    fakeRunner(ok);
    for (const app of ["meeting-kit", "check-kb"]) {
      const saved = readFileSync(join(tools, app), "utf8");
      rmSync(join(tools, app));
      for (const dryRun of ["false", "true"]) {
        const r = await run(["meeting-synthesis", "", dryRun]);
        expect(r.code, dryRun).toBe(1);
        expect(r.stderr).toContain(`${tools}/${app} is missing`);
        expect(r.stderr).toContain(`the host builds the repository's tools package (meeting-kit, nb-index, check-kb, check-tasks) into ${checkout}/.local/tools`);
      }
      stub(join(tools, app), saved.replace(/^#!.*\n/, ""));
    }
    expect(existsSync(join(dir, "curl.log"))).toBe(false);
    expect(existsSync(join(dir, "runner.args"))).toBe(false);
  });
});
