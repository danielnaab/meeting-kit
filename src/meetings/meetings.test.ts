// `meeting-kit meetings`: the meetings a caller can pass to `meeting-kit run meeting-briefing --meeting ID`, read
// from the configured calendar through a stand-in calendar server. Synthetic events only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configYaml, tempDir, writeFile } from "../runner/testkit.ts";
import { main } from "./command.ts";
import { calendarServer, event, WORK_CALENDAR } from "./testkit.ts";
import type { CalendarEvent } from "../../windmill/f/meeting_kit/meeting_briefing/calendar.ts";

let events: CalendarEvent[] = [];
let extra: Record<string, unknown> = {};
const cal = calendarServer(() => ({ count: events.length, events, ...extra }));
afterAll(() => cal.stop());
beforeEach(() => {
  events = [event(), event({ uid: "u2@example.org", summary: "Focus time", attendee_count: 1 })];
  extra = {};
  cal.calls.length = 0;
});

function repo(calendarUrl = cal.url): string {
  const root = tempDir("meetings-test-");
  writeFile(root, "meeting-kit.yaml", configYaml({ calendarUrl }));
  return root;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
}

const ENV = { MCP_API_KEY: "test-key" };

describe("meetings --json", () => {
  test("lists the day's meetings in the meetings/1 shape, each with the ID --meeting takes", async () => {
    const o = io();
    const code = await main(["--json", "--date", "2026-11-09", "--root", repo()], { env: ENV, ...o });
    expect(code, o.err.join("\n")).toBe(0);
    expect(o.out).toHaveLength(1);
    expect(JSON.parse(o.out[0]!)).toEqual({
      schema: "meetings/1",
      date: "2026-11-09",
      calendar: WORK_CALENDAR,
      meetings: [
        {
          id: "2026-11-09/u1@example.org",
          title: "Sprint review",
          start: "2026-11-09T10:00:00-07:00",
          end: "2026-11-09T10:30:00-07:00",
          calendar: WORK_CALENDAR,
          uid: "u1@example.org",
          attendee_count: 5,
        },
      ],
      dropped: [{ title: "Focus time", start: "2026-11-09T10:00:00-07:00", reason: "no other attendees" }],
      stale_calendars: [],
      omitted: 0,
    });
  });

  test("reads the configured calendar for that day, with the key from the configured environment variable", async () => {
    const o = io();
    await main(["--json", "--date", "2026-11-09", "--root", repo()], { env: ENV, ...o });
    expect(cal.calls).toEqual([
      { name: "Calendar__events", args: { start: "2026-11-09", end: "2026-11-09", calendars: [WORK_CALENDAR] }, key: "test-key" },
    ]);
  });

  test("the date defaults to today in the configured time zone", async () => {
    const o = io();
    // 2026-11-10 03:00 UTC is still the evening of 2026-11-09 in Denver (the test config's zone).
    await main(["--json", "--root", repo()], { env: ENV, now: new Date("2026-11-10T03:00:00Z"), ...o });
    expect(JSON.parse(o.out[0]!).date).toBe("2026-11-09");
  });

  test("optional event fields are carried when the calendar has them", async () => {
    events = [event({ location: "Room 4", organizer: "lead@example.org", recurring: true, status: "tentative", description: "agenda" })];
    const o = io();
    await main(["--json", "--date", "2026-11-09", "--root", repo()], { env: ENV, ...o });
    const [m] = JSON.parse(o.out[0]!).meetings;
    expect(m).toMatchObject({ location: "Room 4", organizer: "lead@example.org", recurring: true, status: "tentative" });
    expect(m.description).toBeUndefined();
  });

  test("a stale calendar and a capped listing are reported", async () => {
    extra = { stale_calendars: [{ calendar: WORK_CALENDAR, last_synced: null }], omitted: 3 };
    const o = io();
    await main(["--json", "--date", "2026-11-09", "--root", repo()], { env: ENV, ...o });
    expect(JSON.parse(o.out[0]!)).toMatchObject({ stale_calendars: [{ calendar: WORK_CALENDAR, last_synced: null }], omitted: 3 });
  });
});

describe("meetings (human output)", () => {
  test("one line per meeting, ID first, and what was left out", async () => {
    const o = io();
    const code = await main(["--date", "2026-11-09", "--root", repo()], { env: ENV, ...o });
    expect(code).toBe(0);
    const text = o.out.join("\n");
    expect(text).toContain("2026-11-09/u1@example.org  10:00-10:30  Sprint review");
    expect(text).toMatch(/not listed: Focus time \(10:00\): no other attendees/);
    expect(() => JSON.parse(text)).toThrow();
  });

  test("an empty day says so", async () => {
    events = [];
    const o = io();
    expect(await main(["--date", "2026-11-09", "--root", repo()], { env: ENV, ...o })).toBe(0);
    expect(o.out.join("\n")).toContain(`no meetings on 2026-11-09 in ${WORK_CALENDAR}`);
  });
});

describe("errors: what failed, and the command that fixes it", () => {
  test("a bad date exits 2", async () => {
    const o = io();
    expect(await main(["--date", "tomorrow", "--root", repo()], { env: ENV, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/--date must be YYYY-MM-DD/);
    expect(o.out).toEqual([]);
  });

  test("an unknown option exits 2 with the usage", async () => {
    const o = io();
    expect(await main(["--input", "{}"], { env: ENV, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/unknown option --input\nusage: meeting-kit meetings/);
  });

  test("no meeting-kit.yaml exits 2", async () => {
    const o = io();
    expect(await main(["--root", tempDir()], { env: ENV, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/meeting-kit\.yaml/);
  });

  test("the key's environment variable unset exits 2, naming it", async () => {
    const o = io();
    expect(await main(["--date", "2026-11-09", "--root", repo()], { env: {}, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/MCP_API_KEY is not set.*mcp\.apiKey\.env/s);
    expect(cal.calls).toEqual([]);
  });

  test("a calendar the server can't read exits 1, with the retry command", async () => {
    const broken = calendarServer(() => ({ error: "unknown calendar" }));
    const o = io();
    const root = repo(broken.url);
    try {
      expect(await main(["--json", "--date", "2026-11-09", "--root", root], { env: ENV, ...o })).toBe(1);
    } finally {
      broken.stop();
    }
    expect(o.err.join("\n")).toMatch(/unknown calendar/);
    expect(o.err.join("\n")).toContain(`meeting-kit meetings --date 2026-11-09 --root ${root}`);
    expect(o.out).toEqual([]);
  });
});

test("the meeting-kit command dispatches `meetings`", async () => {
  const root = repo();
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../cli.ts"), "meetings", "--json", "--date", "2026-11-09", "--root", root], {
    env: { ...process.env, ...ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  expect(JSON.parse(out).schema).toBe("meetings/1");
});

test("the Windmill templates the CLI imports hold no placeholders, so the CLI runs them as rendered", async () => {
  for (const path of ["meeting_briefing/calendar.ts", "shared/mcp.ts"]) {
    const text = await Bun.file(join(import.meta.dir, "../../windmill/f/meeting_kit", path)).text();
    expect(text, path).not.toContain("{{");
  }
});
