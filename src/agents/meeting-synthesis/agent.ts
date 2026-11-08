/**
 * Meeting synthesis: one synthesis note per pending transcript (see ../../vault/meetings.ts), then a line per
 * synthesis under the meeting day's `## Meeting Summaries`.
 *
 * `prepare` picks the oldest pending transcripts (a few per run, to bound cost; the derived queue brings the
 * rest next run), names the exact synthesis path for each, and pre-resolves the attendees against
 * wiki/people/. The model reads the transcripts and creates the notes (instructions.md). `finish` writes the
 * daily-note lines from each synthesis's frontmatter.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { AgentDefinition, FinishContext, FinishResult, PrepareContext, Prepared } from "../types.ts";
import { appendDaily, dailyPath } from "../../vault/daily.ts";
import { splitNote } from "../../vault/frontmatter.ts";
import { MEETINGS, meetingFile, pendingTranscripts, TRANSCRIPTS } from "../../vault/meetings.ts";
import { People, PEOPLE, type PersonRef, type Resolution } from "../../people/people.ts";

export const MAX_MEETINGS = 4;
const LOOK_BACK_DAYS = 7;
const SECTION = "Meeting Summaries";
const NOTEBOOK = "notebook";

/**
 * A Bun.Glob (which has no extglob negation) for names in one folder ending in `.md` but not `<suffix>.md`:
 * one alternative per position k from the end, matching names that agree with the suffix's last k-1 characters
 * and differ at the k-th. (A name no longer than the suffix that ends in part of it never matches; dated names
 * are always longer.)
 */
function notEndingWith(folder: string, suffix: string): string {
  const alternatives = [...suffix].map((_, i) => {
    const tail = suffix.slice(suffix.length - i);
    return `*[!${suffix[suffix.length - 1 - i]}]${tail}`;
  });
  return `${folder}/{${alternatives.join(",")}}.md`;
}

const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
/** Synthesis notes: records/meetings/YYYY-MM/*.md, but not briefings (*-briefing.md). */
const SYNTHESES = notEndingWith(`${NOTEBOOK}/${MEETINGS}/*`, "-briefing");
const SYNTHESIS = new Bun.Glob(SYNTHESES);

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.trim() !== "");

/** A Markdown link to a person note from a synthesis note (records/meetings/YYYY-MM/). */
const personLink = (from: string, p: PersonRef) => `[${p.title}](${posix.relative(posix.dirname(from), p.path)})`;

function describeAttendee(from: string, attendee: string, resolution: Resolution): string {
  switch (resolution.status) {
    case "found":
      return `${attendee} → ${personLink(from, resolution.person)}`;
    case "candidates":
      return `${attendee} → candidates (decide from context, or leave plain): ${resolution.candidates.map((p) => personLink(from, p)).join(", ")}`;
    case "unknown":
      return `${attendee} → unknown (no person note)`;
  }
}

function prepare({ root, today }: PrepareContext): Prepared | null {
  const pending = pendingTranscripts(root, { today, days: LOOK_BACK_DAYS });
  if (pending.length === 0) return null;
  const people = People.load(root);

  const meetings = pending.slice(0, MAX_MEETINGS).map((transcript, i) => {
    const [, date, slug] = DATED.exec(posix.basename(transcript))!;
    const synthesis = meetingFile("synthesis", date!, slug!).target;
    const meta = splitNote(readFileSync(join(root, NOTEBOOK, transcript), "utf8")).frontmatter ?? {};
    const title = typeof meta.title === "string" ? meta.title : slug!;
    const attendees = strings(meta.attendees).map((a) => `   - ${describeAttendee(synthesis, a, people.resolve(a))}`);
    return [
      `${i + 1}. "${title}" (${date})`,
      `   transcript: ${NOTEBOOK}/${transcript}`,
      `   synthesis:  ${NOTEBOOK}/${synthesis}`,
      attendees.length ? `   attendees (pre-resolved; links are relative to the synthesis note):\n${attendees.join("\n")}` : "   attendees: none listed",
    ].join("\n");
  });

  const prompt = [
    `Today is ${today}. Synthesize these meeting transcripts, one synthesis note each, following your instructions.`,
    `Write each synthesis at exactly the path given. Person notes are in ${NOTEBOOK}/${PEOPLE}/.`,
    "",
    ...meetings.flatMap((m) => [m, ""]),
    "End with a short message: what you wrote, and any transcript you did not synthesize and why.",
  ].join("\n");
  return { prompt };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const escapeLinkText = (text: string) => text.replace(/[\[\]]/g, (c) => `\\${c}`);

/**
 * A Meeting Summaries line for each synthesis. A note with `skipped` is a stub for a recording the model judged not
 * to be a work meeting: it keeps the transcript out of the queue, gets no daily line, and becomes a notice.
 */
function finish({ root, created }: FinishContext): FinishResult {
  const notices: string[] = [];
  for (const path of created.filter((p) => SYNTHESIS.match(p) && DATED.test(posix.basename(p))).sort()) {
    const inNotebook = posix.relative(NOTEBOOK, path);
    const [, date] = DATED.exec(posix.basename(path))!;
    const meta = splitNote(readFileSync(join(root, path), "utf8")).frontmatter ?? {};
    if (meta.skipped) {
      const transcript = `${NOTEBOOK}/${TRANSCRIPTS}${inNotebook.slice(MEETINGS.length)}`;
      notices.push(
        `Not synthesized, judged not a work meeting: ${transcript}. If it should be, delete ${path} and the next run synthesizes it.`,
      );
      continue;
    }
    const title = typeof meta.title === "string" && meta.title.trim() ? oneLine(meta.title) : posix.basename(path, ".md");
    const summary = typeof meta.summary === "string" ? oneLine(meta.summary) : "";
    const link = posix.relative(posix.dirname(dailyPath(date!)), inNotebook);
    appendDaily(root, date!, SECTION, `- **[${escapeLinkText(title)}](${link})**${summary ? ` · ${summary}` : ""}`);
  }
  return { notices };
}

const agent: AgentDefinition = {
  name: "meeting-synthesis",
  instructions: "src/agents/meeting-synthesis/instructions.md",
  // Sonnet, as in the old pipeline: summarizing a transcript already in context does not need Opus, and on Opus
  // a seven-meeting night once exhausted the session limit.
  model: "sonnet",
  // No PushNotification: a skipped recording reaches the owner through finish's notice, which the Windmill flow alerts on.
  tools: ["Read", "Grep", "Glob", "Write"],
  mcpServers: [],
  writes: {
    create: [SYNTHESES, `${NOTEBOOK}/${PEOPLE}/*.md`],
    modify: [`${NOTEBOOK}/records/daily/*/*.md`],
  },
  prepare,
  finish,
};

export default agent;
