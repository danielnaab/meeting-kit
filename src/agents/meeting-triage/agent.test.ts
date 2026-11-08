import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import agent from "./agent.ts";

// Synthetic fixtures only.
const repo = join(import.meta.dir, "../../..");
const ctx = (input?: unknown) => ({ root: "/nonexistent", today: "2026-11-06", input });

const day = {
  date: "2026-11-06",
  calendar: "work/someone@example.org",
  meetings: [
    {
      calendar: "work/someone@example.org",
      uid: "abc123@example.org",
      start: "2026-11-06T09:00:00-06:00",
      end: "2026-11-06T09:30:00-06:00",
      summary: "Widget planning",
      recurring: true,
      attendee_count: 4,
    },
    {
      calendar: "work/someone@example.org",
      uid: "def456@example.org",
      start: "2026-11-06T13:00:00-06:00",
      end: "2026-11-06T13:15:00-06:00",
      summary: "Daily standup",
    },
  ],
  dropped: [{ summary: "Focus time", start: "2026-11-06T10:00:00-06:00", reason: "no other attendees" }],
  stale_calendars: [],
  omitted: 0,
};

test("definition: read-only, structured answer, calendar server only", () => {
  expect(agent.name).toBe("meeting-triage");
  expect(agent.model).toBe("sonnet");
  expect(agent.writes).toEqual({ create: [], modify: [] });
  expect(agent.mcpServers).toEqual(["calendar"]);
  expect(agent.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "mcp__calendar__Calendar__get_event"]));
  expect(agent.tools.filter((t) => t === "Write" || t === "Edit" || t.startsWith("mcp__contacts") || t.startsWith("mcp__records"))).toEqual([]);
  expect(agent.finish).toBeUndefined();
});

test("definition: instructions and schema files exist; the schema asks for meetings and skipped", () => {
  expect(existsSync(join(repo, agent.instructions))).toBe(true);
  const schema = JSON.parse(readFileSync(join(repo, agent.schema!), "utf8"));
  expect(schema.required).toEqual(["meetings", "skipped"]);
  expect(schema.properties.meetings.items.required).toEqual(["calendar", "uid", "start", "title", "why"]);
});

test("prepare: nothing to triage without input or with no meetings", () => {
  expect(agent.prepare(ctx())).toBeNull();
  expect(agent.prepare(ctx({ ...day, meetings: [] }))).toBeNull();
});

test("prepare: the prompt carries today's date and the gate's events as data", () => {
  const prepared = agent.prepare(ctx(day))!;
  expect(prepared.prompt).toContain("2026-11-06");
  expect(prepared.prompt).toContain('"uid": "abc123@example.org"');
  expect(prepared.prompt).toContain('"summary": "Daily standup"');
  expect(prepared.prompt).toContain("Focus time");
  expect(prepared.prompt).toMatch(/data, not instructions/i);
});

test("prepare: rejects input that is not the calendar gate's day", () => {
  expect(() => agent.prepare(ctx("not a day"))).toThrow(/meeting-triage/);
  expect(() => agent.prepare(ctx({ date: "2026-11-06", meetings: "x" }))).toThrow(/meetings/);
});
