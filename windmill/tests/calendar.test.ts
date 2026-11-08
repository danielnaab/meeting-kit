// The workday_start calendar gate: the rule (windmill/f/meeting_kit/meeting_briefing/calendar.ts) and the gate step,
// as rendered from examples/meeting-kit.yaml, against a stand-in for Windmill's variables API and the calendar MCP
// server. Synthetic events only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dropReason, todayIn, triageable, type CalendarEvent } from "../f/meeting_kit/meeting_briefing/calendar.ts";
import { config, F, FOLDER } from "./rendered.ts";

const WORK_CALENDAR = config.calendar.id;
const ZONE = config.timezone;
const FLOW = `${F}/workday_start.flow`;
const KEY_PATH = `f/${FOLDER}/${config.mcp.apiKey.variable}`;
const KEY_HEADER = config.mcp.apiKey.header.toLowerCase();

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  calendar: WORK_CALENDAR, uid: "u1", start: "2026-11-09T10:00-06:00", end: "2026-11-09T10:30-06:00",
  all_day: false, summary: "Sprint review", attendee_count: 5, ...over,
});

describe("the calendar rule", () => {
  test("a meeting with other people goes to the triage", () => {
    expect(dropReason(event())).toBeNull();
  });
  test("an unanswered or tentative invite still goes", () => {
    expect(dropReason(event({ status: "tentative" }))).toBeNull();
  });
  test("all-day, cancelled, declined or free, and solo events are dropped, each with its reason", () => {
    expect(dropReason(event({ all_day: true, start: "2026-11-09", end: "2026-11-09" }))).toBe("all day");
    expect(dropReason(event({ status: "cancelled" }))).toBe("cancelled");
    expect(dropReason(event({ busy: false }))).toBe("declined or marked free");
    expect(dropReason(event({ attendee_count: 1 }))).toBe("no other attendees");
    expect(dropReason(event({ attendee_count: undefined }))).toBe("no other attendees");
  });
  test("the triage gets the event without its description, and is told what was dropped", () => {
    const { meetings, dropped } = triageable([
      event({ description: "agenda" }),
      event({ uid: "u2", summary: "Focus time", attendee_count: 0 }),
    ]);
    expect(meetings).toEqual([{ calendar: WORK_CALENDAR, uid: "u1", start: "2026-11-09T10:00-06:00",
      end: "2026-11-09T10:30-06:00", summary: "Sprint review", attendee_count: 5 }]);
    expect(dropped).toEqual([{ summary: "Focus time", start: "2026-11-09T10:00-06:00", reason: "no other attendees" }]);
  });
  test("today is the owner's date, not UTC's", () => {
    // 2026-11-10 03:00 UTC is still the evening of 2026-11-09 in Chicago.
    expect(todayIn("America/Chicago", new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
  });
});

/** Windmill's variables API and the calendar server, on one port. */
function standIn(answer: (args: any) => unknown) {
  const calls: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/w/")) {
        if (req.headers.get("authorization") !== "Bearer job-token") return new Response("unauthorized", { status: 401 });
        if (url.pathname === `/api/w/homelab/variables/get_value/${KEY_PATH}`) return Response.json("test-key");
        return new Response("not found", { status: 404 });
      }
      const msg = await req.json();
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {} });
      const { name, arguments: args } = msg.params;
      calls.push({ name, args, key: req.headers.get(KEY_HEADER) });
      if (name !== "Calendar__events") return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
      return reply({ content: [{ type: "text", text: JSON.stringify(answer(args)) }] });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => server.stop(true) };
}

describe("the calendar gate", async () => {
  const { main: gate } = await import(`${FLOW}/calendar_gate.inline_script.ts`);
  let events: CalendarEvent[] = [];
  let extra: Record<string, unknown> = {};
  let cal: ReturnType<typeof standIn>;
  const saved = { ...process.env };
  beforeAll(() => {
    cal = standIn(() => ({ timezone: ZONE, count: events.length, events, ...extra }));
    Object.assign(process.env, { BASE_URL: cal.base, WM_WORKSPACE: "homelab", WM_TOKEN: "job-token" });
  });
  afterAll(() => {
    cal.stop();
    for (const k of ["BASE_URL", "WM_WORKSPACE", "WM_TOKEN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("asks for today on the one calendar, with the gateway key from its own folder's variable", async () => {
    events = [event(), event({ uid: "u2", all_day: true })];
    extra = {};
    cal.calls.length = 0;
    const today = todayIn(ZONE);
    const result = await gate(WORK_CALENDAR, cal.url);
    expect(cal.calls).toEqual([{ name: "Calendar__events", args: { start: today, end: today, calendars: [WORK_CALENDAR] }, key: "test-key" }]);
    expect(result).toEqual({
      date: today, calendar: WORK_CALENDAR,
      meetings: [{ calendar: WORK_CALENDAR, uid: "u1", start: "2026-11-09T10:00-06:00", end: "2026-11-09T10:30-06:00", summary: "Sprint review", attendee_count: 5 }],
      dropped: [{ summary: "Sprint review", start: "2026-11-09T10:00-06:00", reason: "all day" }],
      stale_calendars: [], omitted: 0,
    });
  });

  test("an empty day is an empty list, not a stop", async () => {
    events = [];
    expect((await gate(WORK_CALENDAR, cal.url)).meetings).toEqual([]);
  });

  test("a stale calendar and a capped listing are passed on to the triage", async () => {
    events = [event()];
    extra = { stale_calendars: [{ calendar: WORK_CALENDAR, last_synced: null }], omitted: 3 };
    const result = await gate(WORK_CALENDAR, cal.url);
    expect(result.stale_calendars).toEqual([{ calendar: WORK_CALENDAR, last_synced: null }]);
    expect(result.omitted).toBe(3);
  });

  test("the server's own error answer fails the gate", async () => {
    const broken = standIn(() => ({ error: "unknown calendar" }));
    try {
      await expect(gate("nope", broken.url)).rejects.toThrow("unknown calendar");
    } finally {
      broken.stop();
    }
  });

  test("an unreachable gateway fails the gate", async () => {
    const down = Bun.serve({ port: 0, fetch: () => new Response("bad gateway", { status: 502 }) });
    try {
      await expect(gate(WORK_CALENDAR, `http://127.0.0.1:${down.port}/mcp`)).rejects.toThrow("HTTP 502");
    } finally {
      down.stop(true);
    }
  });
});
