/**
 * The meetings a caller can name: one day of the repository's calendar (meeting-kit.yaml `calendar.id`), read through
 * its calendar MCP server (`mcp.servers.calendar`) with the rule the workday_start calendar gate applies
 * (windmill/f/meeting_kit/meeting_briefing/calendar.ts, shared rather than repeated). `meeting-kit meetings` lists
 * them; `meeting-kit run meeting-briefing --meeting ID` names one.
 *
 * A meeting's ID is `<date>/<uid>`: the day it was listed for and its calendar uid. A recurring series shares one uid,
 * so the date picks the occurrence. IDs are stable for the day, whatever happens to the title or the time.
 *
 * The listing is the versioned `meetings/1` shape (docs/cli.md). A change that would break a reader gets a new
 * schema name, `meetings/2`; a new optional field does not.
 */
import { day, todayIn, type Day, type Dropped, type Meeting as CalendarMeeting } from "../../windmill/f/meeting_kit/meeting_briefing/calendar.ts";
import { mcpClient, type McpClient } from "../../windmill/f/meeting_kit/shared/mcp.ts";
import type { MeetingKitConfig } from "../config/config.ts";

export const MEETINGS_SCHEMA = "meetings/1";

/** One meeting a caller can pass to `--meeting`. Optional fields appear only when the calendar has them. */
export interface Meeting {
  id: string;
  title: string;
  start: string;
  end: string;
  calendar: string;
  uid: string;
  location?: string;
  organizer?: string;
  attendee_count?: number;
  recurring?: boolean;
  status?: string;
}

/** `meeting-kit meetings --json`. */
export interface MeetingsListing {
  schema: typeof MEETINGS_SCHEMA;
  date: string;
  calendar: string;
  meetings: Meeting[];
  /** Events on the calendar that are not meetings to prepare for, and why: they can't be passed to --meeting. */
  dropped: { title: string; start: string; reason: string }[];
  /** As the calendar server reports them: calendars not synced lately, whose events may be missing. */
  stale_calendars: unknown[];
  /** Events past the server's per-call cap, which nobody saw. */
  omitted: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const meetingId = (date: string, uid: string) => `${date}/${uid}`;

/** `<date>/<uid>` split, or null when `id` isn't one. */
export function parseMeetingId(id: string): { date: string; uid: string } | null {
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const date = id.slice(0, slash);
  const uid = id.slice(slash + 1);
  return isDate(date) && uid.trim() !== "" ? { date, uid } : null;
}

/** A setup problem the caller fixes before trying again (exit 2), as opposed to a calendar that failed (exit 1). */
export class CalendarSetupError extends Error {}

/** The calendar server's client, from the config and the key in the configured environment variable. */
export function calendarClient(config: MeetingKitConfig, env: Record<string, string | undefined>): McpClient {
  const server = config.mcp.servers.calendar;
  if (!server) throw new CalendarSetupError("meeting-kit.yaml has no mcp.servers.calendar: add the calendar server's url there");
  const { header, env: name } = config.mcp.apiKey;
  const key = env[name];
  if (!key) throw new CalendarSetupError(`${name} is not set: the calendar server's key (meeting-kit.yaml mcp.apiKey.env). Set it and run the command again`);
  return mcpClient(server.url, { [header]: key }, "meeting-kit");
}

export function today(config: MeetingKitConfig, now = new Date()): string {
  return todayIn(config.timezone, now);
}

function toMeeting(date: string, m: CalendarMeeting): Meeting {
  const optional = {
    location: m.location,
    organizer: m.organizer,
    attendee_count: m.attendee_count,
    recurring: m.recurring,
    status: m.status,
  };
  return {
    id: meetingId(date, m.uid),
    title: m.summary,
    start: m.start,
    end: m.end,
    calendar: m.calendar,
    uid: m.uid,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

const toDropped = (d: Dropped) => ({ title: d.summary, start: d.start, reason: d.reason });

export function listing(d: Day): MeetingsListing {
  return {
    schema: MEETINGS_SCHEMA,
    date: d.date,
    calendar: d.calendar,
    meetings: d.meetings.map((m) => toMeeting(d.date, m)),
    dropped: d.dropped.map(toDropped),
    stale_calendars: d.stale_calendars,
    omitted: d.omitted,
  };
}

/** One day of the configured calendar. A calendar the server can't read throws. */
export async function listMeetings(client: McpClient, config: MeetingKitConfig, date: string): Promise<MeetingsListing> {
  return listing(await day(client, date, config.calendar.id));
}

export class MeetingNotFound extends Error {}

/** The meeting `id` names, read from the calendar now. One that isn't listed for its day throws MeetingNotFound. */
export async function findMeeting(client: McpClient, config: MeetingKitConfig, id: string): Promise<Meeting & { date: string }> {
  const parsed = parseMeetingId(id);
  if (!parsed) throw new MeetingNotFound(`${id} is not a meeting ID (<date>/<uid>); list them with: meeting-kit meetings`);
  const day = await listMeetings(client, config, parsed.date);
  const matches = day.meetings.filter((m) => m.uid === parsed.uid);
  if (matches.length !== 1) {
    const why = matches.length ? `${matches.length} meetings share that uid that day` : "it is not among that day's meetings";
    throw new MeetingNotFound(`no meeting ${id}: ${why}; list them with: meeting-kit meetings --date ${parsed.date}`);
  }
  return { date: parsed.date, ...matches[0]! };
}
