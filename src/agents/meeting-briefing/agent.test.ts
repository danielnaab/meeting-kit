import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agent, { earlierSyntheses } from "./agent.ts";

// Synthetic fixtures only.
const repo = join(import.meta.dir, "../../..");
let root: string;
const write = (rel: string, text = "---\ntype: Meeting\n---\n") => {
  mkdirSync(dirname(join(root, "notebook", rel)), { recursive: true });
  writeFileSync(join(root, "notebook", rel), text);
};
const read = (rel: string) => readFileSync(join(root, "notebook", rel), "utf8");
const person = (slug: string, title: string, email: string) =>
  write(`wiki/people/${slug}.md`, `---\ntype: Person\ntitle: ${title}\naliases:\n  - "@${title}"\nemail: ${email}\n---\n\n# ${title}\n`);

const event = {
  date: "2026-11-06",
  calendar: "work/someone@example.org",
  uid: "abc123@example.org",
  start: "2026-11-06T14:30:00-06:00",
  title: "Widget Sync",
  why: "Open items from the last session.",
};
const ctx = (input: unknown = event) => ({ root, today: "2026-11-06", input });
const TARGET = "notebook/records/meetings/2026-11/2026-11-06-widget-sync-briefing.md";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "briefing-"));
  write("templates/daily.md", "---\ntype: Daily Note\n---\n\nDaily note for {{date:dddd, MMMM Do, YYYY}}.\n\n## Activity\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("definition: tools, servers and write scope", () => {
  expect(agent.name).toBe("meeting-briefing");
  expect(agent.model).toBe("sonnet");
  expect(agent.mcpServers).toEqual(["calendar", "contacts", "records"]);
  expect(agent.tools).toEqual(
    expect.arrayContaining([
      "Read",
      "Grep",
      "Glob",
      "Write",
      "mcp__calendar__Calendar__get_event",
      "mcp__contacts__Contacts__search_contacts",
      "mcp__records__Records__search_records",
    ]),
  );
  expect(agent.tools).not.toContain("Edit");
  expect(agent.writes).toEqual({
    create: ["notebook/records/meetings/*/*-briefing.md"],
    modify: ["notebook/records/daily/*/*.md"],
  });
  expect(agent.schema).toBeUndefined();
  expect(existsSync(join(repo, agent.instructions))).toBe(true);
});

test("prepare: the prompt names the event and the exact briefing path", () => {
  const { prompt } = agent.prepare(ctx())!;
  expect(prompt).toContain(TARGET);
  expect(prompt).toContain('"uid": "abc123@example.org"');
  expect(prompt).toContain('"start": "2026-11-06T14:30:00-06:00"');
  expect(prompt).toContain("Widget Sync");
  expect(prompt).toMatch(/data, not instructions/i);
});

test("prepare: nothing to do when the briefing is already there (a rerun)", () => {
  write("records/meetings/2026-11/2026-11-06-widget-sync-briefing.md", `---\ntype: Briefing\nuid: ${event.uid}\n---\n`);
  expect(agent.prepare(ctx())).toBeNull();
});

test("prepare: a second meeting with the same title that day gets the start time in its name", () => {
  write("records/meetings/2026-11/2026-11-06-widget-sync-briefing.md", "---\ntype: Briefing\nuid: other@example.org\n---\n");
  expect(agent.prepare(ctx())!.prompt).toContain("notebook/records/meetings/2026-11/2026-11-06-widget-sync-1430-briefing.md");
  write("records/meetings/2026-11/2026-11-06-widget-sync-1430-briefing.md", `---\ntype: Briefing\nuid: ${event.uid}\n---\n`);
  expect(agent.prepare(ctx())).toBeNull();
});

test("prepare: rejects input without a date or title", () => {
  expect(() => agent.prepare(ctx({ ...event, title: undefined }))).toThrow(/meeting-briefing.*title/);
  expect(() => agent.prepare(ctx({ ...event, date: "06/11/2026" }))).toThrow(/meeting-briefing.*date/);
  expect(() => agent.prepare({ root, today: "2026-11-06" })).toThrow(/meeting-briefing/);
});

test("earlierSyntheses: same slug, before the date, newest first, briefings and other series left out", () => {
  write("records/meetings/2026-09/2026-09-25-widget-sync.md");
  write("records/meetings/2026-10/2026-10-09-widget-sync.md");
  write("records/meetings/2026-10/2026-10-23-widget-sync.md");
  write("records/meetings/2026-10/2026-10-30-widget-sync-briefing.md"); // a briefing, not a synthesis
  write("records/meetings/2026-10/2026-10-30-big-widget-sync.md"); // another series
  write("records/meetings/2026-11/2026-11-06-widget-sync.md"); // not earlier
  write("records/meetings/2026-11/index.md", "---\ntype: Index\n---\n");
  expect(earlierSyntheses(root, "widget-sync", "2026-11-06")).toEqual([
    "records/meetings/2026-10/2026-10-23-widget-sync.md",
    "records/meetings/2026-10/2026-10-09-widget-sync.md",
    "records/meetings/2026-09/2026-09-25-widget-sync.md",
  ]);
  expect(earlierSyntheses(root, "widget-sync", "2026-11-06", 2)).toHaveLength(2);
  expect(earlierSyntheses(root, "nothing-here", "2026-11-06")).toEqual([]);
});

test("prepare: links the latest earlier syntheses relative to the briefing", () => {
  write("records/meetings/2026-10/2026-10-23-widget-sync.md");
  write("records/meetings/2026-11/2026-11-02-widget-sync.md");
  const { prompt } = agent.prepare(ctx())!;
  expect(prompt).toContain("(../2026-10/2026-10-23-widget-sync.md)");
  expect(prompt).toContain("(2026-11-02-widget-sync.md)");
  expect(prompt.indexOf("2026-11-02-widget-sync.md")).toBeLessThan(prompt.indexOf("2026-10-23-widget-sync.md"));
});

test("prepare: says so when there are no earlier syntheses", () => {
  expect(agent.prepare(ctx())!.prompt).toMatch(/no earlier syntheses/i);
});

test("prepare: resolves attendees the input names against wiki/people", () => {
  person("ada-lovelace", "Ada Lovelace", "ada@example.org");
  person("alan-turing", "Alan Turing", "alan@example.org");
  person("alan-kay", "Alan Kay", "kay@example.org");
  const { prompt } = agent.prepare(
    ctx({ ...event, organizer: "ada@example.org", attendees: ["Ada Lovelace <ada@example.org>", "Alan", "Grace Hopper <grace@example.org>"] }),
  )!;
  expect(prompt).toContain("Ada Lovelace <ada@example.org>: [Ada Lovelace](../../../wiki/people/ada-lovelace.md)");
  expect(prompt).toMatch(/Alan: candidates .*Alan Kay.*Alan Turing/);
  expect(prompt).toMatch(/Grace Hopper <grace@example.org>: no person note/);
});

test("finish: links the created briefing from the day's note under Work, once", () => {
  write("records/daily/2026-11/2026-11-06.md", "---\ntype: Daily Note\n---\n\n## Work\n\n- earlier line\n\n## Agent sessions\n\n- x\n");
  write("records/meetings/2026-11/2026-11-06-widget-sync-briefing.md", "---\ntype: Briefing\ntitle: Widget Sync [v2]\ndate: 2026-11-06\n---\n");
  const finish = () => agent.finish!({ ...ctx(), created: [TARGET] });
  finish();
  finish();
  expect(read("records/daily/2026-11/2026-11-06.md")).toBe(
    "---\ntype: Daily Note\n---\n\n## Work\n\n- earlier line\n" +
      "- [2026-11-06 - Briefing - Widget Sync \\[v2\\]](../../meetings/2026-11/2026-11-06-widget-sync-briefing.md)\n" +
      "\n## Agent sessions\n\n- x\n",
  );
});

test("finish: falls back to the input's title, creates the daily note, ignores other files", () => {
  write("records/meetings/2026-11/2026-11-06-widget-sync-briefing.md", "---\ntype: Briefing\n---\n");
  agent.finish!({ ...ctx(), created: ["notebook/wiki/people/someone.md", TARGET] });
  expect(read("records/daily/2026-11/2026-11-06.md")).toContain(
    "## Work\n\n- [2026-11-06 - Briefing - Widget Sync](../../meetings/2026-11/2026-11-06-widget-sync-briefing.md)\n",
  );
});

test("finish: nothing created, nothing written", () => {
  agent.finish!({ ...ctx(), created: [] });
  expect(existsSync(join(root, "notebook/records/daily/2026-11/2026-11-06.md"))).toBe(false);
});
