/**
 * The vault's meeting layout, shared by the importer, capture, and the agents: dated slug file names, with the
 * real title kept in frontmatter.
 *
 *   transcript  raw/meetings/2026-11/2026-11-05-business-updates.md
 *   synthesis   records/meetings/2026-11/2026-11-05-business-updates.md
 *   briefing    records/meetings/2026-11/2026-11-04-dn-biweekly-briefing.md
 *
 * A synthesis has the same name as its transcript, so the synthesis queue is derived: a transcript without one
 * is pending.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./slug.ts";

export type MeetingKind = "synthesis" | "transcript" | "briefing";

export interface MeetingPath {
  kind: MeetingKind;
  date: string; // YYYY-MM-DD
  slug: string; // the meeting's slug without the date: "business-updates"
  target: string; // path inside notebook/
}

export const TRANSCRIPTS = "raw/meetings";
export const MEETINGS = "records/meetings";

export function meetingFile(kind: MeetingKind, date: string, title: string): MeetingPath {
  const slug = slugify(title) || "untitled-meeting";
  const month = date.slice(0, 7);
  const target =
    kind === "transcript"
      ? `${TRANSCRIPTS}/${month}/${date}-${slug}.md`
      : `${MEETINGS}/${month}/${date}-${slug}${kind === "briefing" ? "-briefing" : ""}.md`;
  return { kind, date, slug, target };
}

const DATED_NOTE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;

/** Dated note names in each YYYY-MM folder under `folder`, as paths inside notebook/. */
function datedNotes(notebook: string, folder: string): string[] {
  const base = join(notebook, folder);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .flatMap((month) => readdirSync(join(base, month)).filter((n) => DATED_NOTE.test(n)).map((n) => `${folder}/${month}/${n}`));
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Transcripts dated within `days` before `today` (inclusive) that have no synthesis of the same name, oldest
 * first, as paths inside notebook/. The look-back keeps a transcript that is never synthesized from being retried
 * forever.
 */
export function pendingTranscripts(root: string, { today, days }: { today: string; days: number }): string[] {
  const notebook = join(root, "notebook");
  const since = daysBefore(today, days);
  const syntheses = new Set(datedNotes(notebook, MEETINGS).map((p) => p.slice(MEETINGS.length)));
  return datedNotes(notebook, TRANSCRIPTS)
    .filter((p) => {
      const date = DATED_NOTE.exec(p.split("/").at(-1)!)![1]!;
      return date >= since && date <= today && !syntheses.has(p.slice(TRANSCRIPTS.length));
    })
    .sort();
}
