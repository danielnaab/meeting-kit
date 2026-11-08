/**
 * The model call: `claude -p` in the clone, with the agent's tool allowlist and nothing else.
 *
 * Permission posture (carried over from the pipeline this runner replaced): `--restricted` drops Bash and WebFetch and
 * confines the file tools to the working directory (the clone); `--allowedTools` is then the whole surface, and a
 * tool not on it is denied without a prompt in -p mode. `--strict-mcp-config` with a config holding only the
 * agent's servers keeps every other MCP server unloaded.
 */
import type { AgentDefinition } from "../agents/types.ts";

/** Always denied, whatever the agent lists. */
export const DISALLOWED_TOOLS = ["Bash", "WebFetch", "WebSearch"];

export interface ClaudeArgsInput {
  prompt: string;
  /** The instructions file's content, appended to the system prompt. */
  instructions: string;
  model?: string;
  tools: string[];
  mcpConfigPath: string;
  /** The JSON Schema file's content, when the agent answers in a shape. */
  schema?: string;
}

/** The argument list after `claude`. The prompt must follow -p directly: --allowedTools is variadic. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  if (input.prompt.startsWith("-")) throw new Error("the prompt must not start with '-' (claude would read it as an option)");
  return [
    "-p",
    input.prompt,
    "--restricted",
    "--append-system-prompt",
    input.instructions,
    ...(input.model ? ["--model", input.model] : []),
    "--allowedTools",
    input.tools.join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    ...(input.schema !== undefined ? ["--json-schema", input.schema] : []),
    "--output-format",
    "json",
  ];
}

export interface McpConfig {
  mcpServers: Record<string, unknown>;
}

/**
 * The given MCP config (`{"mcpServers": {...}}`) narrowed to the agent's servers. A server the agent lists but the
 * config lacks (or no config at all) is simply absent: the repository chose not to configure it, and the agent's
 * instructions say what to do without it.
 */
export function filterMcpConfig(config: unknown, servers: string[]): McpConfig {
  if (servers.length === 0 || config === undefined) return { mcpServers: {} };
  const all = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (!all || typeof all !== "object") throw new Error("the MCP config has no mcpServers object");
  return {
    mcpServers: Object.fromEntries(servers.filter((s) => Object.hasOwn(all, s)).map((s) => [s, (all as Record<string, unknown>)[s]])),
  };
}

export interface ModelResult {
  ok: boolean;
  error?: string;
  result?: string;
  /** structured_output, for an agent with a schema. */
  output?: unknown;
  cost?: number;
  turns?: number;
}

/** Reads `claude --output-format json`. claude can exit 0 on a failed turn, so is_error is checked too. */
export function parseClaudeResult(stdout: string, structured: boolean): ModelResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "claude did not print JSON" };
  }
  const msg = (
    Array.isArray(parsed) ? [...parsed].reverse().find((m) => m?.type === "result") : parsed
  ) as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return { ok: false, error: "claude printed no result message" };
  const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
  const turns = typeof msg.num_turns === "number" ? msg.num_turns : undefined;
  const result = typeof msg.result === "string" ? msg.result : undefined;
  if (msg.is_error === true) return { ok: false, error: `claude reported is_error: ${result ?? ""}`.trim(), result, cost, turns };
  const output = structured ? msg.structured_output : undefined;
  if (structured && (output === null || typeof output !== "object")) {
    return { ok: false, error: "the agent has a schema but claude returned no structured_output object", result, cost, turns };
  }
  return { ok: true, result, output, cost, turns };
}

export interface ModelRequest {
  agent: AgentDefinition;
  /** The clone: the model's working directory. */
  cwd: string;
  prompt: string;
  /** The full argument list after `claude`, from buildClaudeArgs. */
  args: string[];
}

export interface ModelRunner {
  run(request: ModelRequest): Promise<ModelResult>;
}

/** The real model: spawns `claude` (or `bin`) in the clone. stderr passes through to the job log. */
export function claudeModelRunner(bin = "claude"): ModelRunner {
  return {
    async run({ agent, cwd, args }) {
      const proc = Bun.spawn([bin, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const parsed = parseClaudeResult(stdout, agent.schema !== undefined);
      if (code !== 0) return { ...parsed, ok: false, error: `claude exited ${code}${parsed.error ? `: ${parsed.error}` : ""}` };
      return parsed;
    },
  };
}
