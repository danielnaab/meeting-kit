/**
 * Runs one scheduled meeting agent.
 *
 *   meeting-kit run <agent> [--meeting ID [--why TEXT] | --input JSON] [--dry-run] [--keep] [--remote URL] [--mcp-config PATH] [--today YYYY-MM-DD]
 *
 * (that is, `bun src/runner/run.ts <agent> ...` from the kit's checkout). The repository to work on is --remote, or
 * MEETING_KIT_REMOTE; its meeting-kit.yaml supplies everything else about it (runner.ts). MEETING_KIT_TOOLS=<dir>
 * runs the index and checks from <dir> instead of from PATH (runner.ts defaultChecks). MEETING_KIT_FALLBACK_BASE_URL and
 * MEETING_KIT_FALLBACK_TOKEN (and optionally MEETING_KIT_FALLBACK_HEADER) name a gateway to rerun the model on when the
 * account hits its usage limit (claude.ts fallbackFromEnv).
 *
 * Logs go to stderr; the last stdout line is a JSON summary {agent, status, created, cost, output} that a Windmill
 * flow step can read. A failed run exits 1, so Windmill shows the job as failed. A usage error (arguments, or an
 * argument the agent does not take) exits 2 before anything is cloned, with no summary.
 *
 * meeting-briefing takes `--meeting ID` (an ID `meeting-kit meetings` lists), which the runner reads from the
 * calendar through the server and key meeting-kit.yaml names; meeting-triage takes `--input`, the calendar gate's day.
 */
import { resolve } from "node:path";
import type { AgentDefinition } from "../agents/types.ts";
import type { MeetingKitConfig } from "../config/config.ts";
import { calendarClient } from "../meetings/meetings.ts";
import type { McpClient } from "../../windmill/f/meeting_kit/shared/mcp.ts";
import { claudeModelRunner, fallbackFromEnv, type ModelRunner } from "./claude.ts";
import { parseArgs, type RunOptions } from "./cli.ts";
import { type AgentRegistry, defaultRegistry } from "./registry.ts";
import { defaultChecks, type Notifier, runAgent } from "./runner.ts";

const CODE_ROOT = resolve(import.meta.dir, "../..");

export interface MainDeps {
  env: Record<string, string | undefined>;
  registry?: AgentRegistry;
  /** Defaults to the kit's checkout the runner itself runs from. */
  codeRoot?: string;
  model?: ModelRunner;
  /** Defaults to fallbackFromEnv(env): none unless MEETING_KIT_FALLBACK_BASE_URL and _TOKEN are set. */
  fallback?: ModelRunner;
  notifier?: Notifier;
  /** Defaults to defaultChecks(env.MEETING_KIT_TOOLS). */
  checks?: string[][];
  /** The calendar server's client, for --meeting. Defaults to meeting-kit.yaml's calendar server and env's key. */
  calendar?: (config: MeetingKitConfig) => McpClient;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let opts;
  try {
    opts = parseArgs(argv, deps.env);
  } catch (err) {
    deps.stderr((err as Error).message);
    return 2;
  }
  const registry = deps.registry ?? defaultRegistry();
  // An unknown or broken agent is the run's failure (below), reported in its summary like any other.
  const agent = await registry.get(opts.agent).catch(() => undefined);
  const misuse = agent && argumentError(agent, opts);
  if (misuse) {
    deps.stderr(misuse);
    return 2;
  }
  const notifier: Notifier = deps.notifier ?? {
    notify: (s) => deps.stderr(`meeting-kit: ${s.agent} failed: ${s.error ?? "unknown error"}`),
  };
  const summary = await runAgent(opts, {
    registry,
    codeRoot: deps.codeRoot ?? CODE_ROOT,
    model: deps.model ?? claudeModelRunner(),
    fallback: "fallback" in deps ? deps.fallback : fallbackFromEnv(deps.env),
    notifier,
    checks: deps.checks ?? defaultChecks(deps.env.MEETING_KIT_TOOLS),
    calendar: deps.calendar ?? ((config) => calendarClient(config, deps.env)),
    log: (line) => deps.stderr(`[${opts.agent}] ${line}`),
    print: deps.stdout,
  });
  // `error` is present only on a failed run.
  deps.stdout(JSON.stringify(summary));
  return summary.status === "failed" ? 1 : 0;
}

/** Why the agent can't be run with these arguments, with the fix; undefined when it can. */
export function argumentError(agent: AgentDefinition, opts: RunOptions): string | undefined {
  const list = "list the IDs with: meeting-kit meetings";
  if (agent.takes === "meeting") {
    if (opts.input !== undefined) return `${agent.name} takes --meeting ID, not --input; ${list}`;
    if (opts.meeting === undefined) return `${agent.name} needs --meeting ID; ${list}`;
    return undefined;
  }
  if (opts.meeting !== undefined) return `${agent.name} does not take --meeting${agent.takes === "input" ? " (it takes --input)" : ""}`;
  if (opts.input !== undefined && agent.takes !== "input") return `${agent.name} does not take --input`;
  return undefined;
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exit(code);
}
