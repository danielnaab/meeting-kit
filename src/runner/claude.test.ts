import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildClaudeArgs, claudeModelRunner, filterMcpConfig, parseClaudeResult } from "./claude.ts";

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
