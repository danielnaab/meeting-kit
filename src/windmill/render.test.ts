import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type MeetingKitConfig } from "../config/config.ts";
import { KIT_WINDMILL, main, renderTree, templateValues } from "./render.ts";

const EXAMPLES = join(import.meta.dir, "../../examples");
const example = (): MeetingKitConfig => structuredClone(loadConfig(EXAMPLES));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "render-"));
  cpSync(join(EXAMPLES, "meeting-kit.yaml"), join(root, "meeting-kit.yaml"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("renderTree", () => {
  test("renders the kit's folder into the configured one, with a README beside it", () => {
    const files = renderTree(example());
    const paths = [...files.keys()];
    expect(paths).toContain("README.md");
    expect(paths).toContain("f/example_vault/agent/run.sh");
    expect(paths.filter((p) => p !== "README.md").every((p) => p.startsWith("f/example_vault/"))).toBe(true);
  });

  test("no kit folder name and no placeholder survive, in paths or contents", () => {
    for (const [path, text] of renderTree(example())) {
      expect(path).not.toContain("meeting_kit");
      expect(text, path).not.toContain("f/meeting_kit/");
      expect(text, path).not.toContain("{{");
    }
  });

  test("imports and flow paths name the configured folder", () => {
    const files = renderTree(example());
    expect(files.get("f/example_vault/meeting_synthesis/tick.flow/flow.yaml")).toContain("path: f/example_vault/agent/run");
    expect(files.get("f/example_vault/meeting_synthesis/tick.flow/notify.inline_script.ts")).toContain('"f/example_vault/meeting_synthesis/tick"');
    expect(files.get("f/example_vault/agent/run.sh")).toContain("variables/get_value/f/example_vault/$1");
  });

  test("fills the values from the config", () => {
    const c = example();
    const files = renderTree(c);
    const schedule = Bun.YAML.parse(files.get("f/example_vault/workday_start.schedule.yaml")!) as any;
    expect(schedule.schedule).toBe(c.windmill.schedules.workdayStart);
    expect(schedule.timezone).toBe(c.timezone);
    expect(schedule.args.calendar).toBe(c.calendar.id);
    expect(schedule.args.calendar_mcp_url).toBe(c.mcp.servers.calendar!.url);
    const run = files.get("f/example_vault/agent/run.sh")!;
    expect(run).toContain(`export TZ="${c.timezone}"`);
    expect(run).toContain(`mount="${c.windmill.mount}"`);
    expect(run).toContain(`$HOME/${c.windmill.claudeConfigDir}"`);
  });

  test("the MCP config holds every server, with the key header by reference", () => {
    const v = templateValues(example());
    expect(JSON.parse(v.mcp_servers_json!)).toEqual({
      mcpServers: {
        calendar: { type: "http", url: "https://mcp.example.com/calendar/mcp", headers: { "X-API-Key": "${MCP_API_KEY}" } },
        contacts: { type: "http", url: "https://mcp.example.com/contacts/mcp", headers: { "X-API-Key": "${MCP_API_KEY}" } },
      },
    });
  });

  test("the webhook's files are rendered only when the webhook is configured", () => {
    const on = [...renderTree(example()).keys()];
    const webhook = [
      "f/example_vault/meeting_synthesis/on_push.flow/flow.yaml",
      "f/example_vault/meeting_synthesis/on_push.flow/filter.inline_script.ts",
      "f/example_vault/meeting_synthesis/on_push.http_trigger.yaml",
      "f/example_vault/meeting_synthesis/webhook_auth.resource.yaml",
      "f/example_vault/shared/push.ts",
    ];
    for (const p of webhook) expect(on, p).toContain(p);
    const c = example();
    delete c.windmill.webhook;
    const off = [...renderTree(c).keys()];
    expect(off.filter((p) => /on_push|webhook|push\./.test(p))).toEqual([]);
    expect(off.length).toBeLessThan(on.length);
  });

  test("the trigger and its signature check come from the config", () => {
    const files = renderTree(example());
    const trigger = Bun.YAML.parse(files.get("f/example_vault/meeting_synthesis/on_push.http_trigger.yaml")!) as any;
    expect(trigger).toMatchObject({
      script_path: "f/example_vault/meeting_synthesis/on_push", is_flow: true, route_path: "example-vault/meeting-push",
      http_method: "post", is_async: true, request_type: "async", authentication_method: "signature",
      authentication_resource_path: "f/example_vault/meeting_synthesis/webhook_auth", wrap_body: true,
      workspaced_route: false, raw_string: false,
    });
    const auth = Bun.YAML.parse(files.get("f/example_vault/meeting_synthesis/webhook_auth.resource.yaml")!) as any;
    expect(auth.resource_type).toBe("signature_auth");
    expect(auth.value).toEqual({
      signature_provider: "Custom", secret_key: "$var:f/example_vault/webhook_secret",
      authentication_config: { signature_header_name: "X-Forgejo-Signature", algorithm: "sha256", encoding: "hex", signature_prefix: "" },
    });
  });

  test("a value that would break out of its quotes is refused", () => {
    const c = example();
    c.calendar.id = 'work"; rm -rf /';
    expect(() => renderTree(c)).toThrow(/calendar\.id/);
  });

  test("an env name the runner script owns is refused", () => {
    for (const env of ["PATH", "HOME", "WM_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "MEETING_KIT_REMOTE", "GIT_SSH_COMMAND"]) {
      const c = example();
      c.mcp.apiKey.env = env;
      expect(() => renderTree(c), env).toThrow(/mcp\.apiKey\.env/);
    }
  });

  test("the calendar gate needs a calendar server", () => {
    const c = example();
    delete c.mcp.servers.calendar;
    expect(() => renderTree(c)).toThrow(/mcp\.servers\.calendar/);
  });

  test("an unknown placeholder in a template throws", () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    try {
      cpSync(KIT_WINDMILL, kit, { recursive: true });
      writeFileSync(join(kit, "f/meeting_kit/shared/bad.ts"), 'export const x = "{{no_such_value}}";\n');
      expect(() => renderTree(example(), kit)).toThrow(/shared\/bad\.ts: unknown placeholder\(s\) no_such_value/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe("meeting-kit render", () => {
  test("writes the tree into <root>/windmill, then --check finds no drift", async () => {
    const r = await cli(["--root", root]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(root, "windmill/f/example_vault/agent/run.sh"))).toBe(true);
    expect(readFileSync(join(root, "windmill/README.md"), "utf8")).toContain("generated by `meeting-kit render`");
    const c = await cli(["render", "--check"]);
    expect(c.code, c.err + c.out).toBe(0);
  });

  test("removes stale files from the folder, and leaves the rest of windmill/ alone", async () => {
    mkdirSync(join(root, "windmill/f/example_vault/old"), { recursive: true });
    writeFileSync(join(root, "windmill/f/example_vault/old/gone.ts"), "x");
    mkdirSync(join(root, "windmill/f/other"), { recursive: true });
    writeFileSync(join(root, "windmill/f/other/keep.ts"), "y");
    writeFileSync(join(root, "windmill/wmill-lock.yaml"), "z");
    const r = await cli([]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("removed f/example_vault/old/gone.ts");
    expect(existsSync(join(root, "windmill/f/example_vault/old"))).toBe(false);
    expect(readFileSync(join(root, "windmill/f/other/keep.ts"), "utf8")).toBe("y");
    expect(readFileSync(join(root, "windmill/wmill-lock.yaml"), "utf8")).toBe("z");
  });

  test("--check exits 1 and lists the drift", async () => {
    await cli([]);
    writeFileSync(join(root, "windmill/f/example_vault/agent/run.sh"), "edited\n");
    writeFileSync(join(root, "windmill/f/example_vault/extra.ts"), "x");
    rmSync(join(root, "windmill/README.md"));
    const r = await cli(["--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("changed: f/example_vault/agent/run.sh");
    expect(r.err).toContain("missing: README.md");
    expect(r.err).toContain("stale: f/example_vault/extra.ts");
    expect(r.err).toContain("meeting-kit render");
  });

  test("a config change shows up as drift", async () => {
    await cli([]);
    const path = join(root, "meeting-kit.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("America/New_York", "Europe/Berlin"));
    const r = await cli(["--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("changed: f/example_vault/agent/run.sh");
  });

  test("a bad config or argument exits 2 and says why", async () => {
    expect((await cli(["--bogus"])).code).toBe(2);
    rmSync(join(root, "meeting-kit.yaml"));
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("meeting-kit.yaml is missing");
  });
});
