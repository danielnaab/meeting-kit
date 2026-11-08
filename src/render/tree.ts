/**
 * A template tree, rendered into a consuming repository: the generic half of `meeting-kit render`, with nothing
 * meeting-specific in it, so another kit can render its own tree the same way.
 *
 *   template dir + values ──fill──► Map<relpath, content> ──writeTree──► <out>/ (owned paths only)
 *                                                          └──drift────► what differs from <out>/
 *
 * A template is any text file. Rendering does two things, in one pass so a value is never expanded again:
 *   - literal replacements (`f/meeting_kit/` → `f/<folder>/`), so templates stay valid code that imports itself;
 *   - `{{name}}` placeholders, from `values`. An unknown name, or a `{{` left over, throws: a template can never
 *     ship half-filled.
 * Escaping is the caller's: values go in verbatim.
 *
 * The output is owned wholesale: `owned` lists directories (ending in `/`) and files in <out> that the render
 * regenerates. A file in an owned directory that the render did not produce is stale and is removed; everything
 * outside `owned` is left alone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Files = Map<string, string>;

export interface TemplateSpec {
  /** Literal [from, to] replacements. */
  replace?: [string, string][];
  /** `{{name}}` → value. */
  values: Record<string, string>;
}

export class TemplateError extends Error {}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fill one template. `where` names it in errors. */
export function fill(text: string, spec: TemplateSpec, where: string): string {
  const replace = spec.replace ?? [];
  const unknown = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) if (!Object.hasOwn(spec.values, m[1]!)) unknown.add(m[1]!);
  if (unknown.size) throw new TemplateError(`${where}: unknown placeholder(s) ${[...unknown].join(", ")}`);

  const literal = replace.map(([from]) => escape(from));
  const pattern = new RegExp([PLACEHOLDER.source, ...literal].join("|"), "g");
  const out = text.replace(pattern, (match, name: string | undefined) => {
    if (name !== undefined) return spec.values[name]!;
    return replace.find(([from]) => from === match)![1];
  });
  // Left over: a `{{` that opens no whole placeholder, in the template (not in a value, which may hold any text). A
  // lone `}}` is ordinary code (`{ a: { b } }`), so only the opening is checked.
  if (text.replace(PLACEHOLDER, "").includes("{{")) throw new TemplateError(`${where}: leftover {{ that is not a placeholder`);
  return out;
}

/** Every file under `dir`, by path relative to it (always `/`), sorted. */
export function readTree(dir: string): Files {
  const files: Files = new Map();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else files.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  if (existsSync(dir)) walk("");
  return files;
}

/** Render every file under `dir` (those `include` keeps), at the path `rename` gives it. */
export function renderTemplates(
  dir: string,
  spec: TemplateSpec,
  opts: { include?: (rel: string) => boolean; rename?: (rel: string) => string } = {},
): Files {
  const out: Files = new Map();
  for (const [rel, text] of readTree(dir)) {
    if (opts.include && !opts.include(rel)) continue;
    out.set(opts.rename ? opts.rename(rel) : rel, fill(text, spec, rel));
  }
  return out;
}

/** Files under the owned directories of `outDir` today. */
function existing(outDir: string, owned: string[]): string[] {
  const paths: string[] = [];
  for (const o of owned) {
    if (o.endsWith("/")) paths.push(...[...readTree(join(outDir, o)).keys()].map((p) => `${o}${p}`));
    else if (existsSync(join(outDir, o))) paths.push(o);
  }
  return paths;
}

/** How `outDir` differs from `files`: "changed: p", "missing: p", "stale: p", in that order, each sorted. */
export function drift(outDir: string, owned: string[], files: Files): string[] {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, text] of files) {
    const full = join(outDir, path);
    if (!existsSync(full)) missing.push(path);
    else if (readFileSync(full, "utf8") !== text) changed.push(path);
  }
  const stale = existing(outDir, owned).filter((p) => !files.has(p));
  return [
    ...changed.sort().map((p) => `changed: ${p}`),
    ...missing.sort().map((p) => `missing: ${p}`),
    ...stale.sort().map((p) => `stale: ${p}`),
  ];
}

/** Write `files` into `outDir` and remove stale files (and directories they leave empty) in the owned directories. */
export function writeTree(outDir: string, owned: string[], files: Files): { written: string[]; removed: string[] } {
  const removed = existing(outDir, owned).filter((p) => !files.has(p)).sort();
  for (const p of removed) {
    rmSync(join(outDir, p));
    // Prune the directories the removal emptied, up to the owned directory itself.
    let d = dirname(p);
    while (d !== "." && !owned.includes(`${d}/`) && existsSync(join(outDir, d)) && readdirSync(join(outDir, d)).length === 0) {
      rmdirSync(join(outDir, d));
      d = dirname(d);
    }
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), text);
  }
  return { written: [...files.keys()], removed };
}
