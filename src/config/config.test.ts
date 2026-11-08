import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseConfig } from "./config.ts";

const example = join(import.meta.dir, "../../examples");

describe("meeting-kit.yaml", () => {
  test("the shipped example is valid", () => {
    const c = loadConfig(example);
    expect(c.owner.short).toBe("Alex");
    expect(c.agents).toEqual(["meeting-synthesis", "meeting-triage", "meeting-briefing"]);
    expect(c.windmill.webhook).toEqual({ route: "example-vault/meeting-push", signatureHeader: "X-Forgejo-Signature" });
    expect(c.mcp.servers.calendar!.url).toBe("https://mcp.example.com/calendar/mcp");
  });

  test("a missing file says what it is for", () => {
    expect(() => loadConfig(mkdtempSync(join(tmpdir(), "mk-")))).toThrow(/meeting-kit.yaml is missing/);
  });

  test("every problem is listed, unknown keys included", () => {
    const raw = Bun.YAML.parse(require("node:fs").readFileSync(join(example, "meeting-kit.yaml"), "utf8")) as any;
    raw.version = 2;
    raw.owner.nickname = "x";
    raw.timezone = "not a zone";
    raw.windmill.schedules.synthesis = "*/15 * * * *";
    raw.instructions["meeting-synthesis"] = "../outside.md";
    let message = "";
    try {
      parseConfig(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("version: must be 1");
    expect(message).toContain("owner.nickname: unknown key");
    expect(message).toContain("timezone: must be an IANA zone");
    expect(message).toContain("schedules.synthesis: must be a six-field cron");
    expect(message).toContain("instructions.meeting-synthesis: must be a path inside the repository");
  });

  test("the webhook is optional", () => {
    const dir = mkdtempSync(join(tmpdir(), "mk-"));
    const text = require("node:fs").readFileSync(join(example, "meeting-kit.yaml"), "utf8").replace(/  webhook:[\s\S]*$/, "");
    writeFileSync(join(dir, "meeting-kit.yaml"), text);
    expect(loadConfig(dir).windmill.webhook).toBeUndefined();
  });
});
