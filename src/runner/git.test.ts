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
