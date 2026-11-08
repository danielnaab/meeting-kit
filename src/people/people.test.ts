import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitNote } from "../vault/frontmatter.ts";
import { createPerson, People } from "./people.ts";

// Synthetic fixtures only.
let root: string;
const person = (slug: string, frontmatter: string) => {
  writeFileSync(join(root, "notebook/wiki/people", `${slug}.md`), `---\ntype: Person\n${frontmatter}---\n\n# x\n`);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "people-"));
  mkdirSync(join(root, "notebook/wiki/people"), { recursive: true });
  person("pat-lee", 'title: Pat Lee\naliases:\n  - "@Pat Lee"\n  - "@Patricia Lee"\nemail: pat@example.org\n');
  person("renee-munoz", 'title: Renée Muñoz\naliases:\n  - "@Renée Muñoz"\nemail: renee@example.org\nemails:\n  - renee@example.org\n  - rm@example.com\n');
  person("pat-kim", "title: Pat Kim\n");
  writeFileSync(join(root, "notebook/wiki/people/index.md"), "---\ntype: Index\n---\n# People\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const resolve = (query: string) => People.load(root).resolve(query);

test("finds a person by title or alias, ignoring case and accents", () => {
  expect(resolve("Pat Lee")).toEqual({ status: "found", person: { title: "Pat Lee", path: "wiki/people/pat-lee.md" } });
  expect(resolve("patricia lee")).toMatchObject({ status: "found", person: { title: "Pat Lee" } });
  expect(resolve("@Renee Munoz")).toMatchObject({ status: "found", person: { path: "wiki/people/renee-munoz.md" } });
});

test("finds a person by any of their emails, and prefers email in an attendee string", () => {
  expect(resolve("RM@example.com")).toMatchObject({ status: "found", person: { title: "Renée Muñoz" } });
  expect(resolve("Someone Else <pat@example.org>")).toMatchObject({ status: "found", person: { title: "Pat Lee" } });
  expect(resolve("Pat Kim <unknown@example.org>")).toMatchObject({ status: "found", person: { title: "Pat Kim" } });
});

test("a first name alone gives candidates, not a match", () => {
  expect(resolve("Pat")).toEqual({
    status: "candidates",
    candidates: [
      { title: "Pat Kim", path: "wiki/people/pat-kim.md" },
      { title: "Pat Lee", path: "wiki/people/pat-lee.md" },
    ],
  });
  expect(resolve("renee")).toMatchObject({ status: "candidates", candidates: [{ title: "Renée Muñoz" }] });
});

test("an unknown name is unknown", () => {
  expect(resolve("Robin Hart")).toEqual({ status: "unknown" });
  expect(resolve("   ")).toEqual({ status: "unknown" });
});

test("createPerson writes a draft note citing the meeting, and refuses an existing one", () => {
  const path = createPerson(root, {
    name: "Robin Hart",
    email: "robin@example.org",
    source: "records/meetings/2026-11/2026-11-05-weekly-sync.md",
  });
  expect(path).toBe("wiki/people/robin-hart.md");
  const { frontmatter, body } = splitNote(readFileSync(join(root, "notebook", path), "utf8"));
  expect(frontmatter).toEqual({
    type: "Person",
    title: "Robin Hart",
    aliases: ["@Robin Hart"],
    email: "robin@example.org",
    status: "draft",
    sources: [{ id: "2026-11-05-weekly-sync", resource: "../../records/meetings/2026-11/2026-11-05-weekly-sync.md" }],
  });
  expect(body).toBe("\n# Robin Hart\n");
  expect(People.load(root).resolve("Robin Hart")).toMatchObject({ status: "found" });
  expect(() => createPerson(root, { name: "Pat Lee", source: "records/meetings/2026-11/2026-11-05-weekly-sync.md" })).toThrow(/exists/);
});
