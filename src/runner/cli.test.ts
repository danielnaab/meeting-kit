import { expect, test } from "bun:test";
import { localDate, parseArgs } from "./cli.ts";

const env = { MEETING_KIT_REMOTE: "ssh://git.example.com/sam/vault.git" };

test("defaults: remote from the environment, today local", () => {
  expect(parseArgs(["meeting-synthesis"], env, new Date(2026, 10, 6, 23, 30))).toEqual({
    agent: "meeting-synthesis",
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
      "--input",
      '{"id":"e1"}',
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
    input: { id: "e1" },
    dryRun: true,
    keep: true,
    remote: "/srv/repo.git",
    mcpConfigPath: "/etc/mcp.json",
    today: "2026-11-07",
  });
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
