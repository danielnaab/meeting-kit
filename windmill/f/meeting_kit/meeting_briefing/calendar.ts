// meeting_briefing/calendar — meeting-triage (src/agents/meeting-triage/ in meeting-kit) takes its `Day` as its
// input: today's meetings on the owner's work calendar (meeting-kit.yaml `calendar.id`), for the triage to choose
// from.
//
// The rule workday_start's calendar gate (workday_start.flow/calendar_gate.inline_script.ts)
// applies, kept apart from the Windmill glue so the tests can import it. It reads the day through
// the calendar MCP server, the same server and the same copy of the calendar the meeting passes
// read, and never calls a model.
//
// It drops only what is plainly not a meeting to prepare for, and says why for each, so the triage
// can see what it was not shown:
//   - all-day events (out of office, holidays, a conference day);
//   - cancelled events;
//   - events that aren't busy: ones the owner declined, and ones marked free;
//   - events with no other attendees (focus blocks, reminders, travel). Google lists the organizer
//     among the attendees, so a meeting with someone else has at least two.
// Everything else goes to the triage, which decides. A tentative or unanswered invite stays in.
//
// No `main`: Windmill treats this as shared logic, and the gate imports it as
// `../meeting_briefing/calendar.ts`.

import type { McpClient } from "../shared/mcp.ts";

/** An event as the calendar server's `events` tool lists it (render.py, event_dict, full=false). */
export interface CalendarEvent {
  calendar: string;
  uid: string;
  start: string;
  end: string;
  all_day: boolean;
  summary: string;
  location?: string;
  recurring?: boolean;
  status?: string;
  busy?: boolean;
  organizer?: string;
  attendee_count?: number;
  description?: string;
}

/** What the triage is given about one event. The description stays behind: get_event has it. */
export type Meeting = Omit<CalendarEvent, "description" | "all_day" | "busy">;

export interface Dropped { summary: string; start: string; reason: string }

export function dropReason(e: CalendarEvent): string | null {
  if (e.all_day) return "all day";
  if (e.status === "cancelled") return "cancelled";
  if (e.busy === false) return "declined or marked free";
  if ((e.attendee_count ?? 0) < 2) return "no other attendees";
  return null;
}

export function triageable(events: CalendarEvent[]): { meetings: Meeting[]; dropped: Dropped[] } {
  const meetings: Meeting[] = [];
  const dropped: Dropped[] = [];
  for (const e of events) {
    const reason = dropReason(e);
    if (reason) {
      dropped.push({ summary: e.summary, start: e.start, reason });
      continue;
    }
    const { description: _d, all_day: _a, busy: _b, ...meeting } = e;
    meetings.push(meeting);
  }
  return { meetings, dropped };
}

/** Today's date in the owner's time zone: the day the daily notes are named for. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

export interface Day {
  date: string;
  calendar: string;
  meetings: Meeting[];
  dropped: Dropped[];
  /** Calendars the server says haven't synced lately; their events may be missing. */
  stale_calendars: unknown[];
  /** Events past the server's per-call cap, which nobody saw. */
  omitted: number;
}

/** One day of `calendar` through the calendar server. A tool error throws. */
export async function day(client: McpClient, date: string, calendar: string): Promise<Day> {
  const listing = await client.tool("Calendar__events", { start: date, end: date, calendars: [calendar] });
  if (listing.error) throw new Error(`Calendar__events: ${listing.error}`);
  if (!Array.isArray(listing.events)) throw new Error("Calendar__events: no events in the answer");
  return {
    date,
    calendar,
    ...triageable(listing.events),
    stale_calendars: listing.stale_calendars ?? [],
    omitted: listing.omitted ?? 0,
  };
}
