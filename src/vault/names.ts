/**
 * Note names (notebook-kit's naming convention, docs/layout.md#naming): a named note, such as a person, is
 * named by its title, "Pat Lee" -> `Pat Lee.md`, with no `title` or heading repeating it. Mirrors notebook-kit's
 * tools/names.py.
 */

// Characters Obsidian refuses in a filename (* " \ / < > : | ?), or that break its links (# ^ [ ]).
const REPLACE: [RegExp, string][] = [
  [/\s*:\s*/g, " - "],
  [/\s*[/\\|]\s*/g, " - "],
  [/"/g, "'"],
  [/\[/g, "("],
  [/\]/g, ")"],
  [/[?*<>#^]/g, ""],
];
const MAX_BYTES = 200;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const spaced = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** The filename stem nearest to a name: "Q3: plan?" -> "Q3 - plan". Empty when nothing is left. */
export function fileName(name: string): string {
  let out = spaced(name.normalize("NFC"));
  for (const [pattern, replacement] of REPLACE) out = out.replace(pattern, replacement);
  out = spaced(out).replace(/( - )+/g, " - ").replace(/^[ -]+|[ -]+$/g, "").replace(/^\.+\s*/, "");
  while (bytes(out) > MAX_BYTES) out = (out.includes(" ") ? out.slice(0, out.lastIndexOf(" ")) : out.slice(0, -1)).replace(/[ -]+$/, "");
  return out;
}

// What notebook-kit's link rewriting leaves unencoded (Python's quote with safe="/._-~!$&'*+,;=:@").
const SAFE = /[A-Za-z0-9/._\-~!$&'*+,;=:@]/;

/** A relative path as a Markdown link destination: spaces, parentheses and non-ASCII percent-encoded. */
export function linkPath(path: string): string {
  return [...path].map((c) => (SAFE.test(c) ? c : encodeURIComponent(c).replace(/[()]/g, (p) => `%${p.charCodeAt(0).toString(16).toUpperCase()}`))).join("");
}
