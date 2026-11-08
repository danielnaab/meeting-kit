/** Test helpers: temporary bare remotes seeded with synthetic files. Never real meeting data. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Keep the developer's global git config (signing, hooks) out of the tests.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

export function tempDir(prefix = "runner-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function writeFile(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const ID = ["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "-c", "commit.gpgsign=false"];

/** A bare repository on `main` holding `files`; returns its path. */
export function seedRemote(files: Record<string, string>): string {
  const dir = tempDir();
  const remote = join(dir, "remote.git");
  const work = join(dir, "seed");
  sh(dir, "git", "init", "--quiet", "--bare", "--initial-branch=main", remote);
  sh(dir, "git", "init", "--quiet", "--initial-branch=main", work);
  for (const [path, content] of Object.entries(files)) writeFile(work, path, content);
  sh(work, "git", "add", "-A");
  sh(work, "git", ...ID, "commit", "--quiet", "-m", "seed");
  sh(work, "git", "push", "--quiet", remote, "main");
  return remote;
}

/** Pushes a commit to `remote` from a separate clone, as another writer would. */
export function pushConcurrent(remote: string, files: Record<string, string>, append = false): void {
  const work = join(tempDir("concurrent-"), "w");
  sh(dirname(work), "git", "clone", "--quiet", remote, work);
  for (const [path, content] of Object.entries(files)) {
    if (append) {
      const prev = Bun.spawnSync(["cat", join(work, path)]).stdout.toString();
      writeFile(work, path, prev + content);
    } else writeFile(work, path, content);
  }
  sh(work, "git", "add", "-A");
  sh(work, "git", ...ID, "commit", "--quiet", "-m", "concurrent");
  sh(work, "git", "push", "--quiet", "origin", "HEAD:main");
}

/** The remote's file at main, or null. */
export function remoteFile(remote: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "--git-dir", remote, "show", `main:${path}`], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

export function remoteLog(remote: string, format = "%s"): string[] {
  return sh(remote, "git", "--git-dir", remote, "log", `--format=${format}`, "main").trim().split("\n");
}

/** A valid meeting-kit.yaml for a seeded remote: fictional owner, every agent enabled, commits by Test Agents. */
export function configYaml(extra: { agents?: string[]; instructions?: Record<string, string> } = {}): string {
  const lines = [
    "version: 1",
    "owner: { name: Sam Rivera, short: Sam }",
    "organization: Example Co",
    "timezone: America/Denver",
    ...(extra.agents ? [`agents: [${extra.agents.join(", ")}]`] : []),
    "identity: { name: Test Agents, email: agents@example.invalid }",
    ...(extra.instructions
      ? ["instructions:", ...Object.entries(extra.instructions).map(([agent, path]) => `  ${agent}: ${path}`)]
      : []),
    "calendar: { id: work/sam@example.com }",
    "mcp:",
    "  servers: { calendar: { url: https://mcp.example.com/calendar } }",
    "  apiKey: { header: X-API-Key, variable: mcp_api_key, env: MCP_API_KEY }",
    "windmill:",
    "  folder: example_vault",
    "  mount: /opt/example-vault",
    "  claudeConfigDir: .claude-example",
    '  schedules: { synthesis: "0 */15 * * * *", workdayStart: "0 0 6 * * 1-5" }',
  ];
  return `${lines.join("\n")}\n`;
}
