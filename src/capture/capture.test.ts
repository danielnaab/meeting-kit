import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitNote } from "../vault/frontmatter.ts";
import { captureTranscript } from "./capture.ts";

// Synthetic fixture in the shape finalize.py renders.
const RENDERED = [
  "---",
  "date: 2026-11-05",
  "time: 10:03",
  "duration: 41m",
  "participants: 2",
  "source: /audio/2026-11-05-1003-recording.wav",
  'title: "Weekly: Sync"',
  "attendees:",
  "  - Pat Lee <pat@example.org>",
  "calendar_candidates:",
  '  - "Busy (score -1)"',
  "processing:",
  "  model: remote",
  "  elapsed: 3m",
  "---",
  "",
  "# Meeting Transcript",
  "",
  "",
  "[00:00] **SPEAKER_00**: hello",
  "there",
  "",
].join("\n");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("writes the transcript into raw/meetings with type and title first", () => {
  const path = captureTranscript(root, RENDERED);
  expect(path).toBe("raw/meetings/2026-11/2026-11-05-weekly-sync.md");
  const text = readFileSync(join(root, "notebook", path), "utf8");
  const { frontmatter, body } = splitNote(text);
  expect(Object.keys(frontmatter!).slice(0, 3)).toEqual(["type", "title", "date"]);
  expect(frontmatter).toMatchObject({
    type: "Transcript",
    title: "Weekly: Sync",
    date: "2026-11-05",
    time: "10:03",
    attendees: ["Pat Lee <pat@example.org>"],
    calendar_candidates: ["Busy (score -1)"],
    processing: { model: "remote", elapsed: "3m" },
    source: "/audio/2026-11-05-1003-recording.wav",
  });
  expect(body).toBe("\n# Meeting Transcript\n\n\n[00:00] **SPEAKER_00**: hello\nthere\n");
});

test("a second meeting with the same date and title gets a numbered name", () => {
  captureTranscript(root, RENDERED);
  expect(captureTranscript(root, RENDERED)).toBe("raw/meetings/2026-11/2026-11-05-weekly-sync-2.md");
  expect(captureTranscript(root, RENDERED)).toBe("raw/meetings/2026-11/2026-11-05-weekly-sync-3.md");
});

test("refuses a transcript without a date or title, writing nothing", () => {
  expect(() => captureTranscript(root, "---\ntitle: X\n---\nbody\n")).toThrow(/date/);
  expect(() => captureTranscript(root, "---\ndate: 2026-11-05\n---\nbody\n")).toThrow(/title/);
  expect(existsSync(join(root, "notebook"))).toBe(false);
});

test("says so when the frontmatter is not valid YAML", () => {
  expect(() => captureTranscript(root, "---\ndate: 2026-11-05\ntitle: Weekly: Sync\n---\nbody\n")).toThrow(/not valid YAML/);
});
