/**
 * People in wiki/people/: resolve a name, alias, email, or attendee string ("Name <email>") to a person note,
 * and write a draft note for someone new.
 *
 *   bun src/people/people.ts resolve [--root .] QUERY...          one JSON result per query
 *   bun src/people/people.ts create [--root .] --name N --source MEETING [--email E]
 *
 * A match is exact on an email, title, or @alias, ignoring case and accents. A query matching only first names
 * gives candidates; the caller decides.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { renderFrontmatter, splitNote } from "../vault/frontmatter.ts";
import { slugify } from "../vault/slug.ts";

export const PEOPLE = "wiki/people";

export interface PersonRef {
  title: string;
  path: string; // inside notebook/
}

export type Resolution =
  | { status: "found"; person: PersonRef }
  | { status: "candidates"; candidates: PersonRef[] }
  | { status: "unknown" };

const normalize = (text: string) =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/^@/, "").toLowerCase().replace(/\s+/g, " ").trim();

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

const ATTENDEE = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/;

export class People {
  private constructor(
    private readonly byName: Map<string, PersonRef[]>,
    private readonly byEmail: Map<string, PersonRef[]>,
    private readonly all: PersonRef[],
  ) {}

  static load(root: string): People {
    const dir = join(root, "notebook", PEOPLE);
    const byName = new Map<string, PersonRef[]>();
    const byEmail = new Map<string, PersonRef[]>();
    const all: PersonRef[] = [];
    const add = (map: Map<string, PersonRef[]>, key: string, ref: PersonRef) => {
      const refs = map.get(key) ?? [];
      if (!refs.includes(ref)) map.set(key, [...refs, ref]);
    };
    const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "index.md").sort() : [];
    for (const name of names) {
      const meta = splitNote(readFileSync(join(dir, name), "utf8")).frontmatter;
      if (meta?.type !== "Person" || typeof meta.title !== "string") continue;
      const ref = { title: meta.title, path: `${PEOPLE}/${name}` };
      all.push(ref);
      for (const n of [meta.title, ...strings(meta.aliases)]) add(byName, normalize(n), ref);
      for (const e of [...strings(meta.email), ...strings(meta.emails)]) add(byEmail, e.toLowerCase(), ref);
    }
    return new People(byName, byEmail, all);
  }

  resolve(query: string): Resolution {
    const attendee = ATTENDEE.exec(query);
    const email = attendee ? attendee[2]! : query.includes("@") && !query.startsWith("@") ? query.trim() : null;
    const name = normalize(attendee ? attendee[1]! : email ? "" : query);

    const byEmail = email ? this.byEmail.get(email.toLowerCase()) : undefined;
    if (byEmail?.length === 1) return { status: "found", person: byEmail[0]! };
    if (!name) return byEmail?.length ? { status: "candidates", candidates: byEmail } : { status: "unknown" };

    const exact = this.byName.get(name);
    if (exact?.length === 1) return { status: "found", person: exact[0]! };
    const candidates = exact ?? this.all.filter((p) => normalize(p.title).split(" ")[0] === name);
    if (candidates.length) return { status: "candidates", candidates: [...candidates].sort((a, b) => a.title.localeCompare(b.title)) };
    return { status: "unknown" };
  }
}

/** Write a draft person note citing the meeting that introduced them; returns its path inside notebook/. */
export function createPerson(root: string, { name, email, source }: { name: string; email?: string; source: string }): string {
  const title = name.trim();
  const path = `${PEOPLE}/${slugify(title)}.md`;
  const file = join(root, "notebook", path);
  if (!slugify(title)) throw new Error("people: a person needs a name");
  if (existsSync(file) || People.load(root).resolve(title).status === "found") throw new Error(`people: ${title} already exists`);
  const id = posix.basename(source, ".md");
  const frontmatter = renderFrontmatter({
    type: "Person",
    title,
    aliases: [`@${title}`],
    email: email?.toLowerCase(),
    status: "draft",
    sources: [{ id, resource: posix.relative(PEOPLE, source) }],
  });
  mkdirSync(join(root, "notebook", PEOPLE), { recursive: true });
  writeFileSync(file, `${frontmatter}\n# ${title}\n`, { flag: "wx" });
  return path;
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: {
      root: { type: "string", default: "." },
      name: { type: "string" },
      email: { type: "string" },
      source: { type: "string" },
    },
    allowPositionals: true,
  });
  const root = resolvePath(values.root!);
  if (command === "resolve") {
    const people = People.load(root);
    for (const query of positionals) console.log(JSON.stringify({ query, ...people.resolve(query) }));
  } else if (command === "create" && values.name && values.source) {
    console.log(createPerson(root, { name: values.name, email: values.email, source: values.source }));
  } else {
    console.error("usage: people.ts resolve QUERY... | create --name N --source MEETING [--email E]  [--root .]");
    process.exit(2);
  }
}
