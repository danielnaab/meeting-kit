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
  /** The account's usage limit stopped the run (see isUsageLimit): a fallback may take it over. */
  limited?: boolean;
}

/**
 * Whether claude's output says the account is out of usage: a subscription's session, weekly or monthly limit
 * ("You've hit your weekly limit", "You've hit your org's monthly spend limit", "Claude AI usage limit
 * reached|<reset>") or the API's rate limit. These are the
 * failures a different account can absorb; anything else is the agent's own and is never retried elsewhere.
 */
export function isUsageLimit(text: string | undefined): boolean {
  if (!text) return false;
  return /\bhit your [\w'’ -]{0,40}?\blimit\b|usage limit reached|out of (?:extra )?usage|\brate_limit_error\b/i.test(text);
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
  if (msg.is_error === true) {
    const failed: ModelResult = { ok: false, error: `claude reported is_error: ${result ?? ""}`.trim(), result, cost, turns };
    return isUsageLimit(result) ? { ...failed, limited: true } : failed;
  }
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

/**
 * Environment changes for the `claude` process: a string sets the variable, `undefined` removes it. The runner's own
 * environment is the base.
 */
export type EnvOverrides = Record<string, string | undefined>;

/** The variables that carry the fallback (fallbackFromEnv). claude itself never needs them. */
export const FALLBACK_ENV = ["MEETING_KIT_FALLBACK_BASE_URL", "MEETING_KIT_FALLBACK_TOKEN", "MEETING_KIT_FALLBACK_HEADER"] as const;

const withoutFallback: EnvOverrides = Object.fromEntries(FALLBACK_ENV.map((name) => [name, undefined]));

function spawnEnv(overrides: EnvOverrides): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * The real model: spawns `claude` (or `bin`) in the clone, with `env` applied to the runner's environment. The
 * fallback's variables are always removed. stderr passes through to the job log, and is also read for a usage limit
 * (claude can say so there and exit non-zero without printing a result).
 */
export function claudeModelRunner(bin = "claude", env: EnvOverrides = {}): ModelRunner {
  return {
    async run({ agent, cwd, args }) {
      const proc = Bun.spawn([bin, ...args], {
        cwd,
        env: spawnEnv({ ...withoutFallback, ...env }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text().then((text) => {
          if (text) process.stderr.write(text);
          return text;
        }),
        proc.exited,
      ]);
      const parsed = parseClaudeResult(stdout, agent.schema !== undefined);
      if (code !== 0) {
        const failed = { ...parsed, ok: false, error: `claude exited ${code}${parsed.error ? `: ${parsed.error}` : ""}` };
        return parsed.limited || isUsageLimit(stderr) || isUsageLimit(stdout) ? { ...failed, limited: true } : failed;
      }
      return parsed;
    },
  };
}

/**
 * The model to fall back on when the account hits its usage limit: claude again, against an Anthropic-compatible
 * gateway, from
 *
 *   MEETING_KIT_FALLBACK_BASE_URL  the gateway's Anthropic API base URL (ANTHROPIC_BASE_URL)
 *   MEETING_KIT_FALLBACK_TOKEN     its key, sent as the bearer token (ANTHROPIC_AUTH_TOKEN)
 *   MEETING_KIT_FALLBACK_HEADER    optional: a header that also carries the key (ANTHROPIC_CUSTOM_HEADERS)
 *
 * The subscription's token and any API key are removed, so the gateway's key is the only credential. Undefined
 * without both of the first two.
 */
export function fallbackFromEnv(env: Record<string, string | undefined>, bin = "claude"): ModelRunner | undefined {
  const baseUrl = env.MEETING_KIT_FALLBACK_BASE_URL?.trim();
  const token = env.MEETING_KIT_FALLBACK_TOKEN?.trim();
  if (!baseUrl || !token) return undefined;
  const header = env.MEETING_KIT_FALLBACK_HEADER?.trim();
  return claudeModelRunner(bin, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_CUSTOM_HEADERS: header ? `${header}: ${token}` : undefined,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  });
}
