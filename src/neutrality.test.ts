/**
 * The kit is public and content-neutral: nothing in it names the person or organization it was first built for.
 * Everything specific lives in the consuming repository (meeting-kit.yaml and its instruction appendices).
 * This file, and the rendered-tree check in windmill/tests/flows.test.ts, are the only tracked files allowed to
 * spell the terms out. The kit's public GitHub owner (github.com/danielnaab, `github:danielnaab/...`) is its home,
 * not a consumer, so that one spelling is allowed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FORBIDDEN = ["flexion", "daniel", "naab", "dnaab", "crushingpennies"];
const ROOT = join(import.meta.dir, "..");
const SELF = relative(ROOT, import.meta.path);
const ALLOWED_FILES = new Set([SELF, "windmill/tests/flows.test.ts"]);
/** The kit's own home on GitHub. */
const OWNER = /danielnaab\//gi;

function trackedFiles(): string[] {
  const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed: ${r.stderr.toString()}`);
  return r.stdout.toString().split("\0").filter((p) => p && !ALLOWED_FILES.has(p));
}

test("no tracked file names the kit's first user", () => {
  const pattern = new RegExp(FORBIDDEN.join("|"), "i");
  const hits: string[] = [];
  for (const path of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes("\0")) continue; // binary
    if (pattern.test(path)) hits.push(`${path} (path)`);
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line.replace(OWNER, ""))) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  expect(hits).toEqual([]);
});
