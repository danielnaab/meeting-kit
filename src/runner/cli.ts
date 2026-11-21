/** Command-line parsing for `meeting-kit run <agent> [options]` (src/runner/run.ts). */
import { parseMeetingId } from "../meetings/meetings.ts";

export interface RunOptions {
  agent: string;
  /** --meeting: a meeting ID from `meeting-kit meetings` (<date>/<uid>), checked for shape only. */
  meeting?: string;
  /** --why: one line on why the meeting gets a briefing; only with --meeting. */
  why?: string;
  /** The --input JSON, parsed: the calendar gate's day, for meeting-triage. */
  input?: unknown;
  dryRun: boolean;
  /** Keep the clone instead of removing it at the end. */
  keep: boolean;
  remote: string;
  mcpConfigPath?: string;
  today: string; // YYYY-MM-DD, local
}

export const USAGE = [
  "usage: meeting-kit run <agent> [--meeting ID [--why TEXT] | --input JSON] [--dry-run] [--keep] [--remote URL] [--mcp-config PATH] [--today YYYY-MM-DD]",
  "  --meeting ID   meeting-briefing: the meeting, by its ID from `meeting-kit meetings`",
  "  --why TEXT     meeting-briefing: one line on why it gets a briefing (optional)",
  "  --input JSON   meeting-triage: the calendar gate's day (optional)",
].join("\n");

export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>, now = new Date()): RunOptions {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "--keep") flags.add(arg);
    else if (["--meeting", "--why", "--input", "--remote", "--mcp-config", "--today"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      values[arg] = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(USAGE);

  const meeting = values["--meeting"];
  const why = values["--why"];
  if (meeting !== undefined && !parseMeetingId(meeting)) {
    throw new Error(`--meeting ${meeting} is not a meeting ID (<date>/<uid>); list the IDs with: meeting-kit meetings`);
  }
  if (meeting !== undefined && values["--input"] !== undefined) throw new Error(`--meeting or --input, not both\n${USAGE}`);
  if (why !== undefined && meeting === undefined) throw new Error(`--why goes with --meeting\n${USAGE}`);
  if (why !== undefined && (/[\r\n]/.test(why) || !why.trim())) throw new Error("--why must be one line of text");

  let input: unknown;
  if (values["--input"] !== undefined) {
    try {
      input = JSON.parse(values["--input"]);
    } catch {
      throw new Error("--input is not valid JSON");
    }
  }
  const today = values["--today"] ?? localDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be YYYY-MM-DD, not ${today}`);
  const remote = values["--remote"] ?? env.MEETING_KIT_REMOTE;
  if (!remote) throw new Error("no remote: pass --remote or set MEETING_KIT_REMOTE");

  return {
    agent: positional[0]!,
    meeting,
    why,
    input,
    dryRun: flags.has("--dry-run"),
    keep: flags.has("--keep"),
    remote,
    mcpConfigPath: values["--mcp-config"],
    today,
  };
}
