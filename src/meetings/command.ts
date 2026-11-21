/**
 * `meeting-kit meetings [--json] [--date YYYY-MM-DD] [--root DIR]`: the meetings that `meeting-kit run
 * meeting-briefing --meeting ID` accepts, from the calendar meeting-kit.yaml (in DIR, default `.`) names. Human
 * lines by default; `--json` prints one `meetings/1` object (docs/cli.md).
 *
 * Exit codes: 0 listed (an empty day too); 1 the calendar could not be read; 2 the command can't start as given
 * (arguments, meeting-kit.yaml, the key's environment variable).
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type MeetingKitConfig } from "../config/config.ts";
import { CalendarSetupError, calendarClient, isDate, listMeetings, today, type MeetingsListing } from "./meetings.ts";

export const USAGE = "usage: meeting-kit meetings [--json] [--date YYYY-MM-DD] [--root DIR]";

export interface MeetingsDeps {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** For "today": defaults to the clock. */
  now?: Date;
}

const hhmm = (iso: string) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;

export function humanLines(l: MeetingsListing): string[] {
  const lines = l.meetings.length
    ? l.meetings.map((m) => `${m.id}  ${hhmm(m.start)}-${hhmm(m.end)}  ${m.title}`)
    : [`no meetings on ${l.date} in ${l.calendar}`];
  for (const d of l.dropped) lines.push(`not listed: ${d.title} (${hhmm(d.start)}): ${d.reason}`);
  if (l.stale_calendars.length) lines.push(`warning: ${l.stale_calendars.length} calendar(s) not synced lately; meetings may be missing`);
  if (l.omitted) lines.push(`warning: ${l.omitted} event(s) past the calendar server's cap were not read`);
  return lines;
}

export async function main(argv: string[], deps: MeetingsDeps): Promise<number> {
  let values: { json?: boolean; date?: string; root?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { json: { type: "boolean" }, date: { type: "string" }, root: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (err) {
    const option = /'(--?[^']+)'/.exec((err as Error).message)?.[1];
    deps.stderr(`${option ? `unknown option ${option}` : (err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    deps.stdout(USAGE);
    return 0;
  }
  if (values.date !== undefined && !isDate(values.date)) {
    deps.stderr(`--date must be YYYY-MM-DD, not ${values.date}\n${USAGE}`);
    return 2;
  }

  const root = resolve(values.root ?? ".");
  let config: MeetingKitConfig;
  let client;
  try {
    config = loadConfig(root);
    client = calendarClient(config, deps.env);
  } catch (err) {
    deps.stderr((err as Error).message);
    if (!(err instanceof CalendarSetupError)) deps.stderr(`check it with: meeting-kit check-config --root ${root}`);
    return 2;
  }

  const date = values.date ?? today(config, deps.now);
  try {
    const listed = await listMeetings(client, config, date);
    if (values.json) deps.stdout(JSON.stringify(listed));
    else for (const line of humanLines(listed)) deps.stdout(line);
    return 0;
  } catch (err) {
    const again = ["meeting-kit meetings", "--date", date, ...(values.root !== undefined ? ["--root", values.root] : []), ...(values.json ? ["--json"] : [])];
    deps.stderr(`cannot read the calendar ${config.calendar.id} for ${date}: ${(err as Error).message}`);
    deps.stderr(`once the calendar server answers, try again: ${again.join(" ")}`);
    return 1;
  }
}
