import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildClaudeArgs, claudeModelRunner, fallbackFromEnv, filterMcpConfig, isUsageLimit, parseClaudeResult } from "./claude.ts";

test("claude args: restricted, allowlisted, strict MCP, JSON output", () => {
  expect(
    buildClaudeArgs({
      prompt: "Synthesize the pending meetings.",
      instructions: "# Instructions\n",
      tools: ["Read", "Glob", "Write"],
      mcpConfigPath: "/tmp/x/mcp.json",
    }),
  ).toEqual([
    "-p",
    "Synthesize the pending meetings.",
    "--restricted",
    "--append-system-prompt",
    "# Instructions\n",
    "--allowedTools",
    "Read,Glob,Write",
    "--disallowedTools",
    "Bash,WebFetch,WebSearch",
    "--mcp-config",
    "/tmp/x/mcp.json",
    "--strict-mcp-config",
    "--output-format",
    "json",
  ]);
});

test("claude args: model and schema when the agent sets them", () => {
  const args = buildClaudeArgs({
    prompt: "p",
    instructions: "i",
    model: "sonnet",
    tools: ["Read"],
    mcpConfigPath: "/m.json",
    schema: '{"type":"object"}',
  });
  expect(args.slice(0, 5)).toEqual(["-p", "p", "--restricted", "--append-system-prompt", "i"]);
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  expect(args.slice(-2)).toEqual(["--output-format", "json"]);
});

test("claude args: a prompt that looks like an option is refused", () => {
  expect(() =>
    buildClaudeArgs({ prompt: "--help", instructions: "i", tools: [], mcpConfigPath: "/m.json" }),
  ).toThrow(/prompt/);
});

test("MCP config keeps only the agent's servers", () => {
  const config = { mcpServers: { calendar: { url: "a" }, records: { url: "b" }, finance: { url: "c" } } };
  expect(filterMcpConfig(config, ["calendar", "records"])).toEqual({
    mcpServers: { calendar: { url: "a" }, records: { url: "b" } },
  });
  expect(filterMcpConfig(undefined, [])).toEqual({ mcpServers: {} });
});

test("a server the agent lists but the MCP config lacks is simply absent", () => {
  expect(filterMcpConfig({ mcpServers: { calendar: {} } }, ["calendar", "contacts"])).toEqual({ mcpServers: { calendar: {} } });
  expect(filterMcpConfig(undefined, ["calendar"])).toEqual({ mcpServers: {} });
});

test("a malformed MCP config is an error", () => {
  expect(() => filterMcpConfig({ servers: {} }, ["calendar"])).toThrow(/mcpServers/);
});

test("parses a successful result with cost and turns", () => {
  const r = parseClaudeResult(
    JSON.stringify({ type: "result", is_error: false, result: "done", total_cost_usd: 0.42, num_turns: 7 }),
    false,
  );
  expect(r).toEqual({ ok: true, result: "done", output: undefined, cost: 0.42, turns: 7 });
});

test("parses structured output when the agent has a schema", () => {
  const r = parseClaudeResult(
    JSON.stringify({ is_error: false, result: "", structured_output: { brief: ["a"] }, total_cost_usd: 0.1, num_turns: 2 }),
    true,
  );
  expect(r.ok).toBe(true);
  expect(r.output).toEqual({ brief: ["a"] });
});

test("is_error, prose instead of structured output, and garbage are failures", () => {
  expect(parseClaudeResult(JSON.stringify({ is_error: true, result: "limit", num_turns: 1 }), false)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/is_error.*limit/),
    turns: 1,
  });
  expect(parseClaudeResult(JSON.stringify({ is_error: false, result: "prose" }), true)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/structured_output/),
  });
  expect(parseClaudeResult("not json", false)).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) });
});

test("a JSON array of messages uses the final result message", () => {
  const r = parseClaudeResult(
    JSON.stringify([{ type: "system" }, { type: "result", is_error: false, result: "ok", num_turns: 3 }]),
    false,
  );
  expect(r).toMatchObject({ ok: true, result: "ok", turns: 3 });
});

test("the claude runner spawns the binary in the clone and reads its JSON", async () => {
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/claude-stub-`));
  const stub = `${dir}/claude`;
  writeFileSync(stub, `#!/bin/sh\nprintf '{"is_error":false,"result":"%s|%s","num_turns":1}' "$PWD" "$2"\n`);
  chmodSync(stub, 0o755);
  const agent = { name: "a", instructions: "i", tools: [], mcpServers: [], writes: { create: [], modify: [] }, prepare: () => null };
  const ok = await claudeModelRunner(stub).run({ agent, cwd: dir, prompt: "hi", args: ["-p", "hi"] });
  expect(ok).toMatchObject({ ok: true, result: `${dir}|hi`, turns: 1 });

  writeFileSync(stub, "#!/bin/sh\nexit 3\n");
  const failed = await claudeModelRunner(stub).run({ agent, cwd: dir, prompt: "hi", args: [] });
  expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/exited 3/) });
});

test("a usage limit is recognized in claude's wording, and nothing else is", () => {
  for (const text of [
    "You've hit your weekly limit · resets Nov 20, 9am",
    "You've hit your session limit",
    "You've hit your limit",
    "Claude AI usage limit reached|1763300000",
    "You're out of extra usage",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  ]) expect(isUsageLimit(text), text).toBe(true);
  for (const text of [undefined, "", "the write scope was violated", "Rate the meeting's limits", "API Error: 500"]) {
    expect(isUsageLimit(text), String(text)).toBe(false);
  }
});

test("an is_error result over a usage limit is marked limited", () => {
  const limited = parseClaudeResult(JSON.stringify({ is_error: true, result: "You've hit your weekly limit" }), false);
  expect(limited).toMatchObject({ ok: false, limited: true });
  const other = parseClaudeResult(JSON.stringify({ is_error: true, result: "boom" }), false);
  expect(other.limited).toBeUndefined();
});

describe("the fallback", () => {
  const agent = { name: "a", instructions: "i", tools: [], mcpServers: [], writes: { create: [], modify: [] }, prepare: () => null };
  const names = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "MEETING_KIT_FALLBACK_TOKEN"];
  let dir: string;
  let stub: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(`${tmpdir()}/claude-fallback-`));
    stub = `${dir}/claude`;
    // Records the credentials it was given, then answers.
    writeFileSync(stub, `#!/bin/sh\nenv > "${dir}/env"\nprintf '{"is_error":false,"result":"ok"}'\n`);
    chmodSync(stub, 0o755);
    for (const n of names) saved[n] = process.env[n];
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    process.env.ANTHROPIC_API_KEY = "stray-key";
    process.env.MEETING_KIT_FALLBACK_TOKEN = "gateway-key";
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const seen = () => {
    const env = Object.fromEntries(
      readFileSync(`${dir}/env`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return Object.fromEntries(names.map((n) => [n, env[n] ?? "UNSET"]));
  };

  test("needs both the base URL and the token", () => {
    expect(fallbackFromEnv({})).toBeUndefined();
    expect(fallbackFromEnv({ MEETING_KIT_FALLBACK_BASE_URL: "https://gw.example/anthropic" })).toBeUndefined();
    expect(fallbackFromEnv({ MEETING_KIT_FALLBACK_TOKEN: "k" })).toBeUndefined();
  });

  test("runs claude on the gateway's key alone", async () => {
    const fallback = fallbackFromEnv(
      { MEETING_KIT_FALLBACK_BASE_URL: "https://gw.example/anthropic", MEETING_KIT_FALLBACK_TOKEN: "gateway-key", MEETING_KIT_FALLBACK_HEADER: "x-gw-key" },
      stub,
    )!;
    expect(await fallback.run({ agent, cwd: dir, prompt: "hi", args: [] })).toMatchObject({ ok: true });
    expect(seen()).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "gateway-key",
      ANTHROPIC_CUSTOM_HEADERS: "x-gw-key: gateway-key",
      ANTHROPIC_API_KEY: "UNSET",
      CLAUDE_CODE_OAUTH_TOKEN: "UNSET",
      MEETING_KIT_FALLBACK_TOKEN: "UNSET",
    });
  });

  test("the subscription's claude never sees the gateway's key", async () => {
    await claudeModelRunner(stub).run({ agent, cwd: dir, prompt: "hi", args: [] });
    expect(seen()).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "subscription-token", MEETING_KIT_FALLBACK_TOKEN: "UNSET" });
  });

  test("a limit claude reports on stderr with no result is marked limited", async () => {
    writeFileSync(stub, "#!/bin/sh\necho \"Claude AI usage limit reached|1763300000\" >&2\nexit 1\n");
    const r = await claudeModelRunner(stub).run({ agent, cwd: dir, prompt: "hi", args: [] });
    expect(r).toMatchObject({ ok: false, limited: true, error: expect.stringMatching(/exited 1/) });
  });
});
