/** Note frontmatter: split and parse a note, and render a frontmatter block. */

export type Frontmatter = Record<string, unknown>;

const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$\n?/m;

/**
 * The parsed frontmatter (null without a block, {} when it does not parse to a mapping) and the body. `invalid`
 * is true when a block is there but is not valid YAML.
 */
export function splitNote(text: string): { frontmatter: Frontmatter | null; body: string; invalid: boolean } {
  const match = BLOCK.exec(text);
  if (!match || match.index !== 0) return { frontmatter: null, body: text, invalid: false };
  let parsed: unknown;
  let invalid = false;
  try {
    parsed = Bun.YAML.parse(match[1] ?? "");
  } catch {
    parsed = {};
    invalid = true;
  }
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Frontmatter) : {};
  return { frontmatter, body: text.slice(match[0].length), invalid };
}

/** A YAML scalar: plain when unambiguous, JSON-quoted otherwise (JSON strings are valid YAML). */
function scalar(value: unknown, inFlow = false): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = value instanceof Date ? value.toISOString() : String(value);
  const plain =
    /^[A-Za-z0-9][A-Za-z0-9 _./@-]*$/.test(text) &&
    !/^(true|false|null|yes|no|~)$/i.test(text) &&
    !/: |\s#/.test(text) &&
    !(inFlow && /[,\[\]{}]/.test(text));
  return plain ? text : JSON.stringify(text);
}

function inlineMapping(value: Record<string, unknown>): string {
  return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${scalar(v, true)}`).join(", ")} }`;
}

/**
 * Render frontmatter in key order. Supports the shapes notes use: scalars, lists of scalars, lists of flat
 * mappings, and flat mappings (written inline, as OKF writes `generated`). Undefined values are skipped.
 */
export function renderFrontmatter(data: Frontmatter): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        if (item && typeof item === "object") {
          const entries = Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined);
          entries.forEach(([k, v], i) => lines.push(`${i === 0 ? "  - " : "    "}${k}: ${scalar(v)}`));
        } else {
          lines.push(`  - ${scalar(item)}`);
        }
      }
    } else if (value && typeof value === "object") {
      lines.push(`${key}: ${inlineMapping(value as Record<string, unknown>)}`);
    } else {
      lines.push(`${key}: ${scalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}
