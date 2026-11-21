import { expect, test } from "bun:test";
import { localDate, parseArgs } from "./cli.ts";

const env = { MEETING_KIT_REMOTE: "ssh://git.example.com/sam/vault.git" };

test("defaults: remote from the environment, today local", () => {
  expect(parseArgs(["meeting-synthesis"], env, new Date(2026, 10, 6, 23, 30))).toEqual({
    agent: "meeting-synthesis",
    meeting: undefined,
    why: undefined,
    input: undefined,
    dryRun: false,
    keep: false,
    remote: "ssh://git.example.com/sam/vault.git",
    mcpConfigPath: undefined,
    today: "2026-11-06",
  });
});

test("every flag", () => {
  const opts = parseArgs(
    [
      "meeting-briefing",
      "--meeting",
      "2026-11-07/abc@example.org",
      "--why",
      "Open items from last time.",
      "--dry-run",
      "--keep",
      "--remote",
      "/srv/repo.git",
      "--mcp-config",
      "/etc/mcp.json",
      "--today",
      "2026-11-07",
    ],
    env,
  );
  expect(opts).toEqual({
    agent: "meeting-briefing",
    meeting: "2026-11-07/abc@example.org",
    why: "Open items from last time.",
    input: undefined,
    dryRun: true,
    keep: true,
    remote: "/srv/repo.git",
    mcpConfigPath: "/etc/mcp.json",
    today: "2026-11-07",
  });
});

test("--input: the calendar gate's day, for meeting-triage", () => {
  expect(parseArgs(["meeting-triage", "--input", '{"meetings":[]}'], env).input).toEqual({ meetings: [] });
});

test("--meeting takes an ID from `meeting-kit meetings`, and --why only goes with it", () => {
  expect(() => parseArgs(["meeting-briefing", "--meeting", "u1@example.org"], env)).toThrow(
    /--meeting u1@example.org is not a meeting ID \(<date>\/<uid>\).*meeting-kit meetings/s,
  );
  expect(() => parseArgs(["meeting-briefing", "--meeting", "2026-11-07/u1", "--input", "{}"], env)).toThrow(/--meeting or --input, not both/);
  expect(() => parseArgs(["meeting-briefing", "--why", "x"], env)).toThrow(/--why goes with --meeting/);
  expect(() => parseArgs(["meeting-briefing", "--meeting", "2026-11-07/u1", "--why", "two\nlines"], env)).toThrow(/--why must be one line/);
});

test("usage errors", () => {
  expect(() => parseArgs([], env)).toThrow(/usage/);
  expect(() => parseArgs(["a", "b"], env)).toThrow(/usage/);
  expect(() => parseArgs(["a", "--bogus"], env)).toThrow(/--bogus/);
  expect(() => parseArgs(["a", "--input"], env)).toThrow(/--input/);
  expect(() => parseArgs(["a", "--input", "{nope"], env)).toThrow(/--input.*JSON/);
  expect(() => parseArgs(["a", "--today", "11/06/2026"], env)).toThrow(/--today/);
  expect(() => parseArgs(["a"], {})).toThrow(/MEETING_KIT_REMOTE/);
});

test("local date pads month and day", () => {
  expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
});

test("usage names the kit's command", () => {
  expect(() => parseArgs([], env)).toThrow(/usage: meeting-kit run <agent>/);
});
