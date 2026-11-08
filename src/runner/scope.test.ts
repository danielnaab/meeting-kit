import { expect, test } from "bun:test";
import { checkFinishChanges, checkModelChanges, parsePorcelain } from "./scope.ts";

const writes = {
  create: ["notebook/records/meetings/*/*.md", "notebook/wiki/people/*.md"],
  modify: ["notebook/records/daily/*/*.md"],
};

test("parses porcelain -z: untracked, modified, deleted, renamed, ignored", () => {
  const z = "?? notebook/a b.md\0 M notebook/x.md\0D  notebook/gone.md\0R  notebook/new.md\0notebook/old.md\0!! .env\0";
  expect(parsePorcelain(z)).toEqual([
    { kind: "new", path: "notebook/a b.md" },
    { kind: "modified", path: "notebook/x.md" },
    { kind: "deleted", path: "notebook/gone.md" },
    { kind: "new", path: "notebook/new.md" },
    { kind: "deleted", path: "notebook/old.md" },
    { kind: "new", path: ".env" },
  ]);
  expect(parsePorcelain("")).toEqual([]);
});

test("the model may create files inside writes.create", () => {
  const r = checkModelChanges(
    [
      { kind: "new", path: "notebook/records/meetings/2026-11/2026-11-06-sync.md" },
      { kind: "new", path: "notebook/wiki/people/pat-lee.md" },
    ],
    writes,
  );
  expect(r).toEqual({
    created: ["notebook/records/meetings/2026-11/2026-11-06-sync.md", "notebook/wiki/people/pat-lee.md"],
    violations: [],
  });
});

test("the model may not create elsewhere, nor modify or delete anything", () => {
  const r = checkModelChanges(
    [
      { kind: "new", path: "notebook/records/meetings/2026-11/ok.md" },
      { kind: "new", path: "AGENTS.md.bak" },
      { kind: "new", path: "notebook/records/meetings/2026-11/index.md" },
      { kind: "modified", path: "notebook/records/daily/2026-11/2026-11-06.md" },
      { kind: "deleted", path: "notebook/wiki/people/pat-lee.md" },
    ],
    writes,
  );
  expect(r.created).toEqual(["notebook/records/meetings/2026-11/ok.md"]);
  expect(r.violations).toEqual([
    "AGENTS.md.bak (created outside writes.create)",
    "notebook/records/meetings/2026-11/index.md (a generated index, written by the model)",
    "notebook/records/daily/2026-11/2026-11-06.md (modified by the model)",
    "notebook/wiki/people/pat-lee.md (deleted by the model)",
  ]);
});

test("after finish: modify globs, generated indexes, and creates are allowed", () => {
  expect(
    checkFinishChanges(
      [
        { kind: "new", path: "notebook/records/meetings/2026-11/ok.md" },
        { kind: "new", path: "notebook/records/meetings/2026-12/index.md" },
        { kind: "modified", path: "notebook/records/daily/2026-11/2026-11-06.md" },
        { kind: "modified", path: "notebook/records/index.md" },
      ],
      writes,
    ),
  ).toEqual([]);
});

test("after finish: code may create a file its modify globs cover (the day's first daily note)", () => {
  expect(checkFinishChanges([{ kind: "new", path: "notebook/records/daily/2026-11/2026-11-08.md" }], writes)).toEqual([]);
});

test("after finish: other modifications, deletions, and stray files are violations", () => {
  expect(
    checkFinishChanges(
      [
        { kind: "modified", path: "README.md" },
        { kind: "modified", path: "notebook/wiki/people/pat-lee.md" },
        { kind: "deleted", path: "notebook/records/daily/2026-11/2026-11-05.md" },
        { kind: "new", path: "notebook/tasks/x.md" },
        { kind: "modified", path: "src/index.md" },
      ],
      writes,
    ),
  ).toEqual([
    "README.md (modified outside writes.modify)",
    "notebook/wiki/people/pat-lee.md (modified outside writes.modify)",
    "notebook/records/daily/2026-11/2026-11-05.md (deleted)",
    "notebook/tasks/x.md (created outside writes.create and writes.modify)",
    "src/index.md (modified outside writes.modify)",
  ]);
});
