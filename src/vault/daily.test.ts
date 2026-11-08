import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendDaily, dailyPath, parseDailyArgs, renderTemplateDate } from "./daily.ts";

// Synthetic fixtures only.
let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, "notebook", rel)), { recursive: true });
  writeFileSync(join(root, "notebook", rel), text);
};
const read = (rel: string) => readFileSync(join(root, "notebook", rel), "utf8");
const TEMPLATE = "---\ntype: Daily Note\n---\n\nDaily note for {{date:dddd, MMMM Do, YYYY}}.\n\n## Activity\n\n<!-- comment -->\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "daily-"));
  write("templates/daily.md", TEMPLATE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("dailyPath", () => {
  expect(dailyPath("2026-11-05")).toBe("records/daily/2026-11/2026-11-05.md");
});

test("renderTemplateDate", () => {
  expect(renderTemplateDate("{{date:dddd, MMMM Do, YYYY}}", "2026-11-05")).toBe("Thursday, November 5th, 2026");
  expect(renderTemplateDate("{{date:YYYY-MM-DD}} {{date}}", "2026-11-01")).toBe("2026-11-01 2026-11-01");
  expect(renderTemplateDate("{{date:Do}} {{date:Do}} {{date:Do}} {{date:Do}}", "2026-11-22")).toBe("22nd 22nd 22nd 22nd");
  expect(["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-23"].map((d) => renderTemplateDate("{{date:Do}}", d))).toEqual(["11th", "12th", "13th", "23rd"]);
});

test("creates the day's note from the template and adds the section in the daily order", () => {
  const result = appendDaily(root, "2026-11-05", "Meeting Summaries", "- one");
  expect(result).toEqual({ path: "records/daily/2026-11/2026-11-05.md", changed: true });
  expect(read(result.path)).toBe(
    "---\ntype: Daily Note\n---\n\nDaily note for Thursday, November 5th, 2026.\n\n## Meeting Summaries\n\n- one\n\n## Activity\n\n<!-- comment -->\n",
  );
});

test("appends at the end of an existing section, before the next one", () => {
  write("records/daily/2026-11/2026-11-05.md", "---\ntype: Daily Note\n---\n\n## Meeting Summaries\n\n- one\n\n## Work\n\n- w\n");
  appendDaily(root, "2026-11-05", "Meeting Summaries", "- two");
  appendDaily(root, "2026-11-05", "Work", "- w2");
  expect(read("records/daily/2026-11/2026-11-05.md")).toBe(
    "---\ntype: Daily Note\n---\n\n## Meeting Summaries\n\n- one\n- two\n\n## Work\n\n- w\n- w2\n",
  );
});

test("a line already in the section is not added again", () => {
  write("records/daily/2026-11/2026-11-05.md", "## Work\n\n- w\n");
  expect(appendDaily(root, "2026-11-05", "Work", "- w").changed).toBe(false);
  expect(read("records/daily/2026-11/2026-11-05.md")).toBe("## Work\n\n- w\n");
});

test("an empty section gets the line after its heading", () => {
  write("records/daily/2026-11/2026-11-05.md", "## Work\n\n## Other\n\n- o\n");
  appendDaily(root, "2026-11-05", "Work", "- w");
  expect(read("records/daily/2026-11/2026-11-05.md")).toBe("## Work\n\n- w\n\n## Other\n\n- o\n");
});

test("a new section goes in the daily order: Meeting Summaries, Work, Activity, Lookups, Agent sessions", () => {
  write("records/daily/2026-11/2026-11-05.md", "intro\n\n## Activity\n\n- a\n\n## Agent sessions\n\n- s\n");
  appendDaily(root, "2026-11-05", "Work", "- w");
  appendDaily(root, "2026-11-05", "Meeting Summaries", "- m");
  appendDaily(root, "2026-11-05", "Lookups", "- l");
  appendDaily(root, "2026-11-05", "Other", "- o");
  expect(read("records/daily/2026-11/2026-11-05.md")).toBe(
    "intro\n\n## Meeting Summaries\n\n- m\n\n## Work\n\n- w\n\n## Activity\n\n- a\n\n## Lookups\n\n- l\n\n## Agent sessions\n\n- s\n\n## Other\n\n- o\n",
  );
});

test("parseDailyArgs takes a list line as the line, not an option", () => {
  expect(parseDailyArgs(["--date", "2026-11-05", "--section", "Work", "- [x](y.md)"])).toEqual({
    root: ".", date: "2026-11-05", section: "Work", line: "- [x](y.md)",
  });
  expect(parseDailyArgs(["--root", "/r", "--section", "Agent sessions", "--date", "2026-11-05", "plain"]).line).toBe("plain");
  expect(() => parseDailyArgs(["--date", "2026-11-05", "- x"])).toThrow(/usage/);
});
