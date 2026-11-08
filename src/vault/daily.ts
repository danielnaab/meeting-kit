/**
 * Daily notes: records/daily/YYYY-MM/YYYY-MM-DD.md, created from templates/daily.md when missing. Agents add
 * lines under a `## ` section (Meeting Summaries, Work); earlier lines are never changed.
 *
 *   bun src/vault/daily.ts [--root .] --date YYYY-MM-DD --section NAME LINE   (LINE may start with "- ")
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const DAILY = "records/daily";
export const TEMPLATE = "templates/daily.md";

/** Where a missing section is added: the imported notes' order, then the template's. */
export const SECTION_ORDER = ["Meeting Summaries", "Work", "Activity", "Lookups", "Agent sessions"];

export const dailyPath = (date: string) => `${DAILY}/${date.slice(0, 7)}/${date}.md`;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** Obsidian's {{date}} and {{date:FORMAT}} placeholders, for the tokens the templates use. */
export function renderTemplateDate(text: string, date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const tokens: Record<string, string> = {
    dddd: DAYS[weekday]!,
    MMMM: MONTHS[month - 1]!,
    YYYY: String(year),
    Do: ordinal(day),
    MM: String(month).padStart(2, "0"),
    DD: String(day).padStart(2, "0"),
  };
  return text.replace(/\{\{date(?::([^}]*))?\}\}/g, (_, format?: string) =>
    format === undefined ? date : format.replace(/dddd|MMMM|YYYY|Do|MM|DD/g, (t) => tokens[t]!),
  );
}

/** Add `line` at the end of the `## section` of the day's note (adding the section if needed), once. */
export function appendDaily(root: string, date: string, section: string, line: string): { path: string; changed: boolean } {
  const path = dailyPath(date);
  const file = join(root, "notebook", path);
  const text = existsSync(file)
    ? readFileSync(file, "utf8")
    : renderTemplateDate(readFileSync(join(root, "notebook", TEMPLATE), "utf8"), date);
  const lines = text.replace(/\n+$/, "").split("\n");
  const heading = `## ${section}`;
  const start = lines.indexOf(heading);

  if (start === -1) {
    // Before the first section that comes after it in the daily order; otherwise at the end.
    const rank = SECTION_ORDER.indexOf(section);
    const before =
      rank === -1 ? -1 : lines.findIndex((l) => l.startsWith("## ") && SECTION_ORDER.indexOf(l.slice(3)) > rank);
    if (before === -1) lines.push("", heading, "", line);
    else lines.splice(before, 0, heading, "", line, "");
  } else {
    let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    if (end === -1) end = lines.length;
    if (lines.slice(start + 1, end).includes(line)) return { path, changed: false };
    let last = end - 1;
    while (last > start && lines[last]!.trim() === "") last--;
    if (last === start) lines.splice(start + 1, 0, "", line);
    else lines.splice(last + 1, 0, line);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  return { path, changed: true };
}

const USAGE = "usage: daily.ts --date YYYY-MM-DD --section NAME LINE [--root .]";

/** CLI arguments. LINE is positional, and usually a list item ("- ..."), so it is never read as an option. */
export function parseDailyArgs(argv: string[]): { root: string; date: string; section: string; line: string } {
  const args = argv.flatMap((a) => (/^-(\s|$)/.test(a) ? ["--", a] : [a]));
  const { values, positionals } = parseArgs({
    args,
    options: { root: { type: "string", default: "." }, date: { type: "string" }, section: { type: "string" } },
    allowPositionals: true,
  });
  if (!values.date || !values.section || positionals.length !== 1) throw new Error(USAGE);
  return { root: values.root!, date: values.date, section: values.section, line: positionals[0]! };
}

if (import.meta.main) {
  try {
    const { root, date, section, line } = parseDailyArgs(Bun.argv.slice(2));
    const result = appendDaily(resolve(root), date, section, line);
    console.log(`${result.changed ? "added to" : "already in"} ${result.path}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
