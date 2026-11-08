/**
 * Runs one scheduled meeting agent.
 *
 *   meeting-kit run <agent> [--input JSON] [--dry-run] [--keep] [--remote URL] [--mcp-config PATH] [--today YYYY-MM-DD]
 *
 * (that is, `bun src/runner/run.ts <agent> ...` from the kit's checkout). The repository to work on is --remote, or
 * MEETING_KIT_REMOTE; its meeting-kit.yaml supplies everything else about it (runner.ts). MEETING_KIT_TOOLS=<dir>
 * runs the index and checks from <dir> instead of from PATH (runner.ts defaultChecks).
 *
 * Logs go to stderr; the last stdout line is a JSON summary {agent, status, created, cost, output} that a Windmill
 * flow step can read. A failed run exits 1, so Windmill shows the job as failed.
 */
import { resolve } from "node:path";
import { claudeModelRunner, type ModelRunner } from "./claude.ts";
import { parseArgs } from "./cli.ts";
import { type AgentRegistry, defaultRegistry } from "./registry.ts";
import { defaultChecks, type Notifier, runAgent } from "./runner.ts";

const CODE_ROOT = resolve(import.meta.dir, "../..");

export interface MainDeps {
  env: Record<string, string | undefined>;
  registry?: AgentRegistry;
  /** Defaults to the kit's checkout the runner itself runs from. */
  codeRoot?: string;
  model?: ModelRunner;
  notifier?: Notifier;
  /** Defaults to defaultChecks(env.MEETING_KIT_TOOLS). */
  checks?: string[][];
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
  const notifier: Notifier = deps.notifier ?? {
    notify: (s) => deps.stderr(`meeting-kit: ${s.agent} failed: ${s.error ?? "unknown error"}`),
  };
  const summary = await runAgent(opts, {
    registry: deps.registry ?? defaultRegistry(),
    codeRoot: deps.codeRoot ?? CODE_ROOT,
    model: deps.model ?? claudeModelRunner(),
    notifier,
    checks: deps.checks ?? defaultChecks(deps.env.MEETING_KIT_TOOLS),
    log: (line) => deps.stderr(`[${opts.agent}] ${line}`),
    print: deps.stdout,
  });
  // `error` is present only on a failed run.
  deps.stdout(JSON.stringify(summary));
  return summary.status === "failed" ? 1 : 0;
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exit(code);
}
