/** Git and command plumbing for the runner. Every call is argv-only (no shell) and runs in a given directory. */
import { type Change, parsePorcelain } from "./scope.ts";

/** Commit author and committer (meeting-kit.yaml `identity`). */
export interface Identity {
  name: string;
  email: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function exec(cmd: string[], cwd: string, env?: Record<string, string>): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await exec(["git", ...args], cwd, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

/** A shallow clone of `remote` into `dir`; returns the checked-out branch. */
export async function clone(remote: string, dir: string): Promise<{ branch: string }> {
  await git(process.cwd(), ["clone", "--quiet", "--depth", "50", remote, dir]);
  const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
  return { branch };
}

/**
 * Every change in the working tree, untracked files listed one by one. With `ignored`, ignored files count as new
 * too: they are never committed, but a model that writes one has still written outside its scope.
 */
export async function status(root: string, { ignored = false } = {}): Promise<Change[]> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...(ignored ? ["--ignored=traditional"] : [])];
  return parsePorcelain(await git(root, args));
}

/** Stages everything and commits it; false when there was nothing to commit. Never signs. */
export async function commitAll(root: string, message: string, identity: Identity): Promise<boolean> {
  await git(root, ["add", "-A"]);
  const staged = await exec(["git", "diff", "--cached", "--quiet"], root);
  if (staged.code === 0) return false;
  await git(
    root,
    // --no-verify: the runner has already run the checks; a host's hooks must not change what an agent commits.
    ["-c", "commit.gpgsign=false", "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--quiet", "--no-verify", "-m", message],
    {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  );
  return true;
}

export type PushResult = { ok: true } | { ok: false; rejected: boolean; error: string };

/** Pushes HEAD to `branch` on origin. `rejected` means the remote moved on: retry on a fresh clone. */
export async function push(root: string, branch: string): Promise<PushResult> {
  const r = await exec(["git", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], root);
  if (r.code === 0) return { ok: true };
  const text = `${r.stdout}\n${r.stderr}`;
  const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info/.test(text);
  return { ok: false, rejected, error: text.trim() };
}
