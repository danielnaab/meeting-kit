/**
 * The write scope check: what changed in the clone, against the agent's `writes`.
 *
 * The model only creates files inside writes.create. After `finish`, existing files may change only inside
 * writes.modify, and generated folder indexes (notebook/** /index.md) are always allowed. Nothing is ever deleted.
 */
import type { WriteScope } from "../agents/types.ts";

export interface Change {
  kind: "new" | "modified" | "deleted";
  path: string;
}

/** Parses `git status --porcelain=v1 -z` (untracked and ignored files count as new). */
export function parsePorcelain(z: string): Change[] {
  const fields = z.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      // A rename or copy is followed by its source path.
      changes.push({ kind: "new", path });
      const source = fields[++i];
      if (xy.includes("R") && source) changes.push({ kind: "deleted", path: source });
    } else if (xy === "??" || xy === "!!" || xy.includes("A")) {
      changes.push({ kind: "new", path });
    } else if (xy.includes("D")) {
      changes.push({ kind: "deleted", path });
    } else {
      changes.push({ kind: "modified", path });
    }
  }
  return changes;
}

const GENERATED_INDEX = new Bun.Glob("notebook/**/index.md");

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => new Bun.Glob(g).match(path));
}

/** The model's changes: created files must be in writes.create; any modification or deletion is a violation. */
export function checkModelChanges(changes: Change[], writes: WriteScope): { created: string[]; violations: string[] } {
  const created: string[] = [];
  const violations: string[] = [];
  for (const { kind, path } of changes) {
    if (kind === "new") {
      if (GENERATED_INDEX.match(path)) violations.push(`${path} (a generated index, written by the model)`);
      else if (matchesAny(path, writes.create)) created.push(path);
      else violations.push(`${path} (created outside writes.create)`);
    } else {
      violations.push(`${path} (${kind} by the model)`);
    }
  }
  return { created, violations };
}

/** All changes after `finish` (and after the index): creates, allowed modifications, and generated indexes. */
export function checkFinishChanges(changes: Change[], writes: WriteScope): string[] {
  const violations: string[] = [];
  for (const { kind, path } of changes) {
    if (kind === "deleted") violations.push(`${path} (deleted)`);
    else if (GENERATED_INDEX.match(path)) continue;
    // Code (finish) may create what it may modify, such as the day's first daily note; the model may not (above).
    else if (kind === "new" && !matchesAny(path, writes.create) && !matchesAny(path, writes.modify)) {
      violations.push(`${path} (created outside writes.create and writes.modify)`);
    }
    else if (kind === "modified" && !matchesAny(path, writes.modify)) violations.push(`${path} (modified outside writes.modify)`);
  }
  return violations;
}
