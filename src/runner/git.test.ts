import { expect, test } from "bun:test";
import { join } from "node:path";
import { clone, commitAll, push, status } from "./git.ts";
import { pushConcurrent, remoteFile, remoteLog, seedRemote, tempDir, writeFile } from "./testkit.ts";

const identity = { name: "Test Agents", email: "agents@example.invalid" };

test("clone, status, commit with the agent identity, push", async () => {
  const remote = seedRemote({ "README.md": "seed\n" });
  const root = join(tempDir(), "repo");
  const { branch } = await clone(remote, root);
  expect(branch).toBe("main");
  expect(await status(root)).toEqual([]);

  writeFile(root, "notebook/out/a.md", "a\n");
  writeFile(root, "README.md", "changed\n");
  expect(await status(root)).toEqual([
    { kind: "modified", path: "README.md" },
    { kind: "new", path: "notebook/out/a.md" },
  ]);

  expect(await commitAll(root, "fixture: create 1 file", identity)).toBe(true);
  expect(await status(root)).toEqual([]);
  expect(await push(root, branch)).toEqual({ ok: true });
  expect(remoteFile(remote, "notebook/out/a.md")).toBe("a\n");
  expect(remoteLog(remote, "%an <%ae>|%cn <%ce>|%s")[0]).toBe(
    "Test Agents <agents@example.invalid>|Test Agents <agents@example.invalid>|fixture: create 1 file",
  );
});

test("nothing staged means no commit", async () => {
  const remote = seedRemote({ "README.md": "seed\n" });
  const root = join(tempDir(), "repo");
  await clone(remote, root);
  expect(await commitAll(root, "nothing", identity)).toBe(false);
});

test("a push behind the remote is reported as rejected", async () => {
  const remote = seedRemote({ "README.md": "seed\n" });
  const root = join(tempDir(), "repo");
  const { branch } = await clone(remote, root);
  pushConcurrent(remote, { "other.md": "x\n" });
  writeFile(root, "mine.md", "y\n");
  await commitAll(root, "mine", identity);
  expect(await push(root, branch)).toEqual({ ok: false, rejected: true, error: expect.stringMatching(/rejected/) });
});

test("a push to an unreachable remote is an error, not a rejection", async () => {
  const remote = seedRemote({ "README.md": "seed\n" });
  const root = join(tempDir(), "repo");
  const { branch } = await clone(remote, root);
  writeFile(root, "mine.md", "y\n");
  await commitAll(root, "mine", identity);
  Bun.spawnSync(["git", "remote", "set-url", "origin", join(tempDir(), "missing.git")], { cwd: root });
  expect(await push(root, branch)).toMatchObject({ ok: false, rejected: false });
});

test("clone fills the repository's scions (git submodules), nested ones too", async () => {
  // file:// submodules need protocol.file.allow; a real repository's scions are https or ssh
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" });
  try {
    const inner = seedRemote({ "README.md": "inner\n" });
    const kit = seedRemote({ "src/vault/daily.ts": "// kit\n" });
    const kitWork = join(tempDir(), "kit");
    Bun.spawnSync(["git", "clone", "--quiet", kit, kitWork]);
    for (const args of [
      ["submodule", "add", "--quiet", `file://${inner}`, ".scions/inner"],
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "graft inner"],
      ["push", "--quiet", "origin", "HEAD:main"],
    ]) expect(Bun.spawnSync(["git", ...args], { cwd: kitWork, env: process.env }).stderr.toString()).toBe("");
    const remote = seedRemote({ "README.md": "seed\n" });
    const work = join(tempDir(), "ws");
    Bun.spawnSync(["git", "clone", "--quiet", remote, work]);
    for (const args of [
      ["submodule", "add", "--quiet", `file://${kit}`, "nix/agent-tools/.scions/meeting-kit"],
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "graft the kit"],
      ["push", "--quiet", "origin", "HEAD:main"],
    ]) expect(Bun.spawnSync(["git", ...args], { cwd: work, env: process.env }).stderr.toString()).toBe("");

    const root = join(tempDir(), "repo");
    await clone(remote, root);
    expect(await Bun.file(join(root, "nix/agent-tools/.scions/meeting-kit/src/vault/daily.ts")).text()).toBe("// kit\n");
    expect(await Bun.file(join(root, "nix/agent-tools/.scions/meeting-kit/.scions/inner/README.md")).text()).toBe("inner\n");
    expect(await status(root)).toEqual([]);
  } finally {
    for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
