/**
 * Capture: land a freshly transcribed meeting in this vault, at the layout in ../vault/meetings.ts.
 *
 *   bun src/capture/capture.ts [--root .] [FILE]     (reads stdin without FILE; prints the note's path)
 *
 * Input is the Markdown the Mac's finalize.py renders: frontmatter with at least `date` and `title`, then the
 * transcript. The note gets `type: Transcript` and `title` first and is never overwritten: a second meeting
 * with the same date and title gets a numbered name. Synthesis picks it up from there (pendingTranscripts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderFrontmatter, splitNote } from "../vault/frontmatter.ts";
import { spaceHeadings } from "../vault/markdown.ts";
import { meetingFile } from "../vault/meetings.ts";

/** Write the rendered transcript under root/notebook and return its path inside notebook/. */
export function captureTranscript(root: string, rendered: string): string {
  const { frontmatter, body, invalid } = splitNote(rendered);
  if (invalid) throw new Error("capture: the transcript's frontmatter is not valid YAML");
  const { type: _type, title, date, ...rest } = frontmatter ?? {};
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("capture: no YYYY-MM-DD date in frontmatter");
  if (typeof title !== "string" || !title.trim()) throw new Error("capture: no title in frontmatter");

  const base = meetingFile("transcript", date, title).target.replace(/\.md$/, "");
  let path = `${base}.md`;
  for (let n = 2; existsSync(join(root, "notebook", path)); n++) path = `${base}-${n}.md`;

  const text = `${renderFrontmatter({ type: "Transcript", title, date, ...rest })}\n${spaceHeadings(body.replace(/^\n+/, "")).replace(/\n*$/, "\n")}`;
  mkdirSync(dirname(join(root, "notebook", path)), { recursive: true });
  writeFileSync(join(root, "notebook", path), text, { flag: "wx" });
  return path;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { root: { type: "string", default: "." } }, allowPositionals: true });
  const rendered = positionals[0] ? readFileSync(positionals[0], "utf8") : await Bun.stdin.text();
  console.log(captureTranscript(resolve(values.root!), rendered));
}
