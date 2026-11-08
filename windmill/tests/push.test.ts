// The push webhook's rule (windmill/f/meeting_kit/shared/push.ts): synthesize after a push to the default branch that
// adds or changes a dated meeting transcript. Payloads are Forgejo's push event, trimmed to what the rule reads.
import { describe, expect, test } from "bun:test";
import { isTranscript, shouldSynthesize } from "../f/meeting_kit/shared/push.ts";

const T = "notebook/raw/meetings/2026-11/2026-11-08-sprint-review.md";
const push = (over: Record<string, unknown> = {}, commits: unknown[] = [{ added: [T], modified: [], removed: [] }]) => ({
  ref: "refs/heads/main",
  repository: { default_branch: "main" },
  commits,
  total_commits: commits.length,
  ...over,
});

describe("a transcript path", () => {
  test("is a dated note in a month folder under notebook/raw/meetings", () => {
    expect(isTranscript(T)).toBe(true);
    for (const p of [
      "notebook/raw/meetings/2026-11/index.md",
      "notebook/raw/meetings/index.md",
      "notebook/raw/meetings/2026-11/2026-11-08-sprint-review.txt",
      "notebook/records/meetings/2026-11/2026-11-08-sprint-review.md",
      "raw/meetings/2026-11/2026-11-08-sprint-review.md",
      "notebook/raw/meetings/2026-11/sub/2026-11-08-x.md",
      "notebook/raw/meetings/2026-11/2026-11-08-.md",
    ]) expect(isTranscript(p), p).toBe(false);
  });
});

describe("shouldSynthesize", () => {
  test("a new or changed transcript on the default branch runs", () => {
    expect(shouldSynthesize(push()).run).toBe(true);
    expect(shouldSynthesize(push({}, [{ added: [], modified: [T], removed: [] }])).run).toBe(true);
  });
  test("any commit of several will do", () => {
    expect(shouldSynthesize(push({}, [{ added: ["notebook/x.md"], modified: [], removed: [] }, { added: [T], modified: [], removed: [] }])).run).toBe(true);
  });
  test("the default branch is the repository's, else main", () => {
    expect(shouldSynthesize(push({ ref: "refs/heads/trunk", repository: { default_branch: "trunk" } })).run).toBe(true);
    expect(shouldSynthesize(push({ ref: "refs/heads/main", repository: { default_branch: "trunk" } })).run).toBe(false);
    expect(shouldSynthesize(push({ repository: undefined })).run).toBe(true);
    expect(shouldSynthesize(push({ ref: "refs/heads/main", repository: {} })).run).toBe(true);
  });
  test("other branches, tags, and a payload with no ref do not run", () => {
    for (const ref of ["refs/heads/feature", "refs/tags/main", "main", undefined]) {
      const r = shouldSynthesize(push({ ref }));
      expect(r.run, String(ref)).toBe(false);
      expect(r.reason, String(ref)).toMatch(/not the default branch|no ref/);
    }
  });
  test("deleting the branch does not run", () => {
    expect(shouldSynthesize(push({ deleted: true })).run).toBe(false);
  });
  test("other files only, and deletions only, do not run", () => {
    expect(shouldSynthesize(push({}, [{ added: ["notebook/daily/2026-11-08.md"], modified: ["notebook/raw/meetings/2026-11/index.md"], removed: [] }])).run).toBe(false);
    const r = shouldSynthesize(push({}, [{ added: [], modified: [], removed: [T] }]));
    expect(r.run).toBe(false);
    expect(r.reason).toContain("no transcript added or modified");
  });
  test("fails open when it cannot see every commit's files", () => {
    for (const [what, payload] of [
      ["no commits list", push({ commits: undefined })],
      ["empty commits list", push({}, [])],
      ["a commit without file lists", push({}, [{ id: "abc" }])],
      ["a truncated commit list", push({ total_commits: 30 }, [{ added: ["x.md"], modified: [], removed: [] }])],
    ] as const) {
      const r = shouldSynthesize(payload);
      expect(r.run, what).toBe(true);
      expect(r.reason, what).toContain("cannot tell");
    }
  });
  test("a transcript it can see wins over commits it cannot, and is named", () => {
    expect(shouldSynthesize(push({ total_commits: 30 }, [{ added: [T], modified: [], removed: [] }])).reason).toContain(T);
  });
  test("a payload that is not an object does not run", () => {
    for (const p of [null, undefined, "x", [], 3]) expect(shouldSynthesize(p).run).toBe(false);
  });
});
