import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agent, { MAX_MEETINGS } from "./agent.ts";

// Synthetic fixtures only: invented people and meetings.
let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const transcript = (title: string, attendees: string[] = []) =>
  `---\ntype: Transcript\ntitle: ${JSON.stringify(title)}\ndate: 2026-11-05\n` +
  (attendees.length ? `attendees:\n${attendees.map((a) => `  - ${JSON.stringify(a)}`).join("\n")}\n` : "") +
  `---\n\nSPEAKER_00: hello\n`;
const person = (title: string, email?: string) =>
  `---\ntype: Person\ntitle: ${title}\naliases:\n  - "@${title}"\n${email ? `email: ${email}\n` : ""}status: draft\n---\n\n# ${title}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "synthesis-"));
  write("notebook/templates/daily.md", "---\ntype: Daily Note\n---\n\nDaily note for {{date}}.\n\n## Activity\n");
  write("notebook/wiki/people/ada-lovelace.md", person("Ada Lovelace", "ada@example.org"));
  write("notebook/wiki/people/grace-hopper.md", person("Grace Hopper"));
  write("notebook/wiki/people/grace-kelly.md", person("Grace Kelly"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("definition", () => {
  test("runs on sonnet with file tools only, and no MCP servers", () => {
    expect(agent.name).toBe("meeting-synthesis");
    expect(agent.model).toBe("sonnet");
    expect([...agent.tools].sort()).toEqual(["Glob", "Grep", "Read", "Write"]);
    expect(agent.mcpServers).toEqual([]);
    expect(existsSync(join(import.meta.dir, "../../..", agent.instructions))).toBe(true);
  });

  test("may create syntheses (not briefings) and draft people, and modify only daily notes", () => {
    const creates = (path: string) => agent.writes.create.some((g) => new Bun.Glob(g).match(path));
    const modifies = (path: string) => agent.writes.modify.some((g) => new Bun.Glob(g).match(path));
    expect(creates("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md")).toBe(true);
    expect(creates("notebook/records/meetings/2026-11/2026-11-05-debriefing.md")).toBe(true);
    expect(creates("notebook/records/meetings/2026-11/2026-11-05-weekly-sync-briefing.md")).toBe(false);
    expect(creates("notebook/wiki/people/new-person.md")).toBe(true);
    expect(creates("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md")).toBe(false);
    expect(creates("notebook/records/meetings/2026-11/sub/x.md")).toBe(false);
    expect(creates("notebook/records/daily/2026-11/2026-11-05.md")).toBe(false);
    expect(modifies("notebook/records/daily/2026-11/2026-11-05.md")).toBe(true);
    expect(modifies("notebook/wiki/people/ada-lovelace.md")).toBe(false);
  });
});

describe("prepare", () => {
  const prepare = () => agent.prepare({ root, today: "2026-11-06" });

  test("nothing pending: null, so the model is not invoked", () => {
    write("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md", transcript("Weekly Sync"));
    write("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "---\ntype: Meeting\n---\n");
    expect(prepare()).toBeNull();
  });

  test("lists each pending transcript with the synthesis path it must write", () => {
    write("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md", transcript("Weekly Sync"));
    write("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync-2.md", transcript("Weekly Sync"));
    const prompt = prepare()!.prompt;
    expect(prompt).toContain("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md");
    expect(prompt).toContain("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md");
    expect(prompt).toContain("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync-2.md");
    expect(prompt).toContain("notebook/records/meetings/2026-11/2026-11-05-weekly-sync-2.md");
    expect(prompt).toContain("Weekly Sync");
  });

  test("pre-resolves attendees: found as a link from the synthesis, candidates and unknowns as such", () => {
    write(
      "notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md",
      transcript("Weekly Sync", ["A. Lovelace <ada@example.org>", "Grace", "Nobody Known <nobody@example.org>"]),
    );
    const prompt = prepare()!.prompt;
    expect(prompt).toContain("A. Lovelace <ada@example.org>");
    expect(prompt).toMatch(/A\. Lovelace <ada@example\.org>.*\[Ada Lovelace\]\(\.\.\/\.\.\/\.\.\/wiki\/people\/ada-lovelace\.md\)/);
    expect(prompt).toMatch(/Grace\b.*candidates.*Grace Hopper.*grace-hopper\.md.*Grace Kelly.*grace-kelly\.md/);
    expect(prompt).toMatch(/Nobody Known <nobody@example\.org>.*unknown/);
  });

  test("a transcript without attendees says so", () => {
    write("notebook/raw/meetings/2026-11/2026-11-05-weekly-sync.md", transcript("Weekly Sync"));
    expect(prepare()!.prompt).toMatch(/attendees: none listed/i);
  });

  test(`caps a run at ${MAX_MEETINGS} meetings, oldest first; the rest wait for the next run`, () => {
    for (let d = 1; d <= MAX_MEETINGS + 2; d++) {
      write(`notebook/raw/meetings/2026-11/2026-11-0${d}-standup.md`, transcript(`Standup ${d}`));
    }
    const prompt = prepare()!.prompt;
    for (let d = 1; d <= MAX_MEETINGS; d++) expect(prompt).toContain(`2026-11-0${d}-standup.md`);
    expect(prompt).not.toContain(`2026-11-0${MAX_MEETINGS + 1}-standup.md`);
    expect(prompt).not.toContain(`2026-11-0${MAX_MEETINGS + 2}-standup.md`);
  });
});

describe("finish", () => {
  const synthesis = (rel: string, meta: string) => write(rel, `---\ntype: Meeting\n${meta}---\n\n# x\n`);
  const finish = (created: string[]) => agent.finish!({ root, today: "2026-11-06", created });
  const daily = (date: string) => read(`notebook/records/daily/${date.slice(0, 7)}/${date}.md`);

  test("adds a Meeting Summaries line per synthesis to the meeting's own day, linked relative to the daily note", () => {
    synthesis("notebook/records/meetings/2026-10/2026-10-31-retro.md", 'title: "Retro: Q4"\ndate: 2026-10-31\nsummary: The team agreed to ship on Friday.\n');
    finish(["notebook/records/meetings/2026-10/2026-10-31-retro.md"]);
    expect(daily("2026-10-31")).toContain(
      "## Meeting Summaries\n\n- **[Retro: Q4](../../meetings/2026-10/2026-10-31-retro.md)** · The team agreed to ship on Friday.\n",
    );
  });

  test("a synthesis without a summary still gets a line with just the link", () => {
    synthesis("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "title: Weekly Sync\ndate: 2026-11-05\n");
    finish(["notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"]);
    expect(daily("2026-11-05")).toContain("\n- **[Weekly Sync](../../meetings/2026-11/2026-11-05-weekly-sync.md)**\n");
  });

  test("a multi-line summary is folded to one line and brackets in titles are escaped", () => {
    synthesis(
      "notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md",
      'title: "[Draft] Weekly Sync"\nsummary: |\n  First line\n  second line.\n',
    );
    finish(["notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"]);
    expect(daily("2026-11-05")).toContain("- **[\\[Draft\\] Weekly Sync](../../meetings/2026-11/2026-11-05-weekly-sync.md)** · First line second line.\n");
  });

  test("a synthesis without a title is listed by its file name", () => {
    synthesis("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "summary: Short.\n");
    finish(["notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"]);
    expect(daily("2026-11-05")).toContain("- **[2026-11-05-weekly-sync](../../meetings/2026-11/2026-11-05-weekly-sync.md)** · Short.\n");
  });

  test("people notes and other created files get no daily line", () => {
    write("notebook/wiki/people/new-person.md", person("New Person"));
    finish(["notebook/wiki/people/new-person.md", "notebook/records/meetings/2026-11/index.md"]);
    expect(existsSync(join(root, "notebook/records/daily/2026-11/2026-11-06.md"))).toBe(false);
    expect(existsSync(join(root, "notebook/records/daily/2026-11/2026-11-05.md"))).toBe(false);
  });

  test("a skipped recording gets no daily line, and a notice naming its transcript", () => {
    const stub = "notebook/records/meetings/2026-11/2026-11-05-call.md";
    synthesis(stub, 'title: Call\ndate: 2026-11-05\nskipped: not a work meeting\n');
    synthesis("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "title: Weekly Sync\nsummary: Short.\n");
    const result = finish([stub, "notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"]);
    expect(daily("2026-11-05")).not.toContain("2026-11-05-call.md");
    expect(daily("2026-11-05")).toContain("2026-11-05-weekly-sync.md");
    expect(result).toEqual({
      notices: [
        "Not synthesized, judged not a work meeting: notebook/raw/meetings/2026-11/2026-11-05-call.md. " +
          `If it should be, delete ${stub} and the next run synthesizes it.`,
      ],
    });
  });

  test("no skipped recordings: no notices", () => {
    synthesis("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "title: Weekly Sync\n");
    expect(finish(["notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"])).toEqual({ notices: [] });
  });

  test("re-running adds nothing twice", () => {
    synthesis("notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md", "title: Weekly Sync\nsummary: Short.\n");
    const created = ["notebook/records/meetings/2026-11/2026-11-05-weekly-sync.md"];
    finish(created);
    const once = daily("2026-11-05");
    finish(created);
    expect(daily("2026-11-05")).toBe(once);
    expect(once.match(/Weekly Sync/g)).toHaveLength(1);
  });
});
