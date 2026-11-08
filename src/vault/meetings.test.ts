import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { meetingFile, pendingTranscripts } from "./meetings.ts";

test("meetingFile places each kind by date and title slug", () => {
  expect(meetingFile("transcript", "2026-11-05", "Weekly, Sync")).toEqual({
    kind: "transcript",
    date: "2026-11-05",
    slug: "weekly-sync",
    target: "raw/meetings/2026-11/2026-11-05-weekly-sync.md",
  });
  expect(meetingFile("synthesis", "2026-11-05", "Weekly, Sync").target).toBe("records/meetings/2026-11/2026-11-05-weekly-sync.md");
  expect(meetingFile("briefing", "2026-11-04", "DN biweekly").target).toBe("records/meetings/2026-11/2026-11-04-dn-biweekly-briefing.md");
});

test("meetingFile falls back to a slug for titles with no letters or digits", () => {
  expect(meetingFile("transcript", "2026-11-05", "<>").slug).toBe("untitled-meeting");
});

// Synthetic fixtures only.
let root: string;
const write = (rel: string, text = "---\ntype: Transcript\n---\n") => {
  mkdirSync(dirname(join(root, "notebook", rel)), { recursive: true });
  writeFileSync(join(root, "notebook", rel), text);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "queue-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("pendingTranscripts: transcripts without a synthesis of the same name, oldest first", () => {
  write("raw/meetings/2026-11/2026-11-05-weekly-sync.md");
  write("records/meetings/2026-11/2026-11-05-weekly-sync.md");
  write("raw/meetings/2026-11/2026-11-06-standup.md");
  write("raw/meetings/2026-10/2026-10-31-retro.md");
  write("records/meetings/2026-10/2026-10-31-retro-briefing.md"); // a briefing is not a synthesis
  write("raw/meetings/2026-11/index.md", "---\ntype: Index\n---\n");
  expect(pendingTranscripts(root, { today: "2026-11-06", days: 30 })).toEqual([
    "raw/meetings/2026-10/2026-10-31-retro.md",
    "raw/meetings/2026-11/2026-11-06-standup.md",
  ]);
});

test("pendingTranscripts looks back a limited number of days", () => {
  write("raw/meetings/2026-10/2026-10-29-old.md");
  write("raw/meetings/2026-10/2026-10-30-recent.md");
  expect(pendingTranscripts(root, { today: "2026-11-06", days: 7 })).toEqual(["raw/meetings/2026-10/2026-10-30-recent.md"]);
});

test("pendingTranscripts with no meetings folder is empty", () => {
  expect(pendingTranscripts(root, { today: "2026-11-06", days: 7 })).toEqual([]);
});
