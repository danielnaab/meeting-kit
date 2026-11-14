/**
 * One run of one meeting agent: fresh clone, config, prepare, model, scope check, finish, index and checks, commit,
 * push.
 *
 * The repository's meeting-kit.yaml is read from the first clone, so a config change reaches the next run with the
 * content at the same commit: it decides whether the agent runs here at all, who commits, and how the kit's
 * instruction template is rendered and which local appendix follows it.
 *
 * Nothing reaches the remote unless every change is inside the agent's write scope and every check passed. A push
 * the remote rejects (another writer got there first) is retried on a fresh clone by replaying the run's
 * deterministic part: the model's created files are written again and `finish` runs again on top of the new state.
 * No model ever rebases or resolves a conflict; a created file that now exists on the remote fails the run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDefinition } from "../agents/types.ts";
import { type AgentName, loadConfig, type MeetingKitConfig } from "../config/config.ts";
import { buildClaudeArgs, filterMcpConfig, type ModelRunner } from "./claude.ts";
import type { RunOptions } from "./cli.ts";
import { clone, commitAll, exec, type Identity, push, status } from "./git.ts";
import { composeInstructions } from "./instructions.ts";
import type { AgentRegistry } from "./registry.ts";
import { checkFinishChanges, checkModelChanges } from "./scope.ts";

export type RunStatus = "nothing-to-do" | "pushed" | "no-changes" | "failed" | "dry-run";

/** The one-line JSON summary printed at the end; `output` is the structured output of a schema agent. */
export interface RunSummary {
  agent: string;
  status: RunStatus;
  created: string[];
  cost: number | null;
  output: unknown;
  /** From the agent's finish: what the owner should hear about even when the run succeeded. */
  notices?: string[];
  error?: string;
}

export interface Notifier {
  notify(summary: RunSummary): void | Promise<void>;
}

/** The index and the checks, in order, as the consuming repository provides them (notebook-kit >= v2.0.0 tools). */
const CHECK_PROGRAMS = ["nb-index", "check-kb", "check-tasks"];

/** Without a tools directory: the programs from PATH. */
export const DEFAULT_CHECKS: string[][] = CHECK_PROGRAMS.map((name) => [name]);

/** With `toolsDir` (MEETING_KIT_TOOLS): the same programs, run from that directory. */
export function defaultChecks(toolsDir?: string): string[][] {
  if (!toolsDir) return DEFAULT_CHECKS;
  return CHECK_PROGRAMS.map((name) => [join(toolsDir, name)]);
}

export const MAX_PUSH_ATTEMPTS = 3;

export interface RunnerDeps {
  registry: AgentRegistry;
  /**
   * The kit's own checkout: agent instruction templates and schemas are read here, the same version as the agent
   * code. The repository's appendices are read from the clone.
   */
  codeRoot: string;
  model: ModelRunner;
  notifier: Notifier;
  /** Run in the clone, in order, after finish: indexes first, then checks. */
  checks?: string[][];
  log?: (line: string) => void;
  /** Dry-run output (stdout). */
  print?: (text: string) => void;
}

class RunFailure extends Error {}

/** Everything the replay on a fresh clone needs. */
interface Outcome {
  files: Map<string, Buffer>;
  output: unknown;
}

export async function runAgent(opts: RunOptions, deps: RunnerDeps): Promise<RunSummary> {
  const log = deps.log ?? ((line) => console.error(`[${opts.agent}] ${line}`));
  const print = deps.print ?? ((text) => console.log(text));
  const checks = deps.checks ?? DEFAULT_CHECKS;
  const summary: RunSummary = { agent: opts.agent, status: "failed", created: [], cost: null, output: null };
  const work = mkdtempSync(join(tmpdir(), `meeting-kit-${opts.agent.replace(/[^\w-]/g, "_")}-`));
  // The MCP config can hold credentials: it lives beside the clone, never inside it, and never outlives the run.
  const mcpConfigPath = join(work, "mcp.json");
  const clones: string[] = [];

  const freshClone = async (): Promise<{ root: string; branch: string }> => {
    const root = join(work, `repo-${clones.length + 1}`);
    clones.push(root);
    const { branch } = await clone(opts.remote, root);
    log(`cloned ${opts.remote} (${branch}) into ${root}`);
    return { root, branch };
  };

  try {
    const agent = await deps.registry.get(opts.agent);
    const first = await freshClone();
    const config = readConfig(first.root);
    if (!(config.agents as string[]).includes(opts.agent)) {
      throw new RunFailure(`${opts.agent} is not enabled in meeting-kit.yaml (agents: ${config.agents.join(", ") || "none"})`);
    }
    const instructions = composeInstructions(
      readRepoFile(deps.codeRoot, agent.instructions, "instructions"),
      config,
      readAppendix(first.root, config.instructions[opts.agent as AgentName]),
    );
    const prepared = agent.prepare({ root: first.root, today: opts.today, input: opts.input });
    if (prepared === null) {
      log("nothing to do");
      summary.status = "nothing-to-do";
      return summary;
    }

    writeFileSync(mcpConfigPath, JSON.stringify(filterMcpConfig(readMcpConfig(opts.mcpConfigPath), agent.mcpServers)), {
      mode: 0o600,
    });
    const args = buildClaudeArgs({
      prompt: prepared.prompt,
      instructions,
      model: agent.model,
      tools: agent.tools,
      mcpConfigPath,
      schema: agent.schema === undefined ? undefined : readRepoFile(deps.codeRoot, agent.schema, "schema"),
    });

    if (opts.dryRun) {
      print(`prompt:\n${prepared.prompt}\n`);
      print(`claude args:\n${JSON.stringify(["claude", ...args], null, 2)}`);
      summary.status = "dry-run";
      return summary;
    }

    const result = await deps.model.run({ agent, cwd: first.root, prompt: prepared.prompt, args });
    summary.cost = result.cost ?? null;
    log(`model: turns=${result.turns ?? "?"} cost_usd=${result.cost ?? "?"}`);
    if (!result.ok) throw new RunFailure(`model failed: ${result.error ?? "unknown error"}`);
    summary.output = result.output ?? null;

    const { created, violations } = checkModelChanges(await status(first.root, { ignored: true }), agent.writes);
    summary.created = created;
    if (violations.length > 0) throw new RunFailure(`write scope violated by the model:\n${violations.join("\n")}`);
    const outcome: Outcome = {
      files: new Map(created.map((path) => [path, readFileSync(join(first.root, path))])),
      output: result.output,
    };

    let target = first;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) {
        target = await freshClone();
        replayCreated(target.root, outcome.files);
      }
      const { committed, notices } = await finishAndCommit(agent, opts, config.identity, target.root, created, outcome.output, checks, log);
      if (notices.length > 0) summary.notices = notices;
      if (!committed) {
        log("no changes; nothing to commit");
        summary.status = "no-changes";
        return summary;
      }
      const pushed = await push(target.root, target.branch);
      if (pushed.ok) {
        log(`pushed to ${target.branch}`);
        summary.status = "pushed";
        return summary;
      }
      if (!pushed.rejected) throw new RunFailure(`push failed: ${pushed.error}`);
      log(`push rejected (attempt ${attempt} of ${MAX_PUSH_ATTEMPTS}): the remote moved on`);
      if (attempt >= MAX_PUSH_ATTEMPTS) throw new RunFailure(`push rejected after ${MAX_PUSH_ATTEMPTS} attempts`);
    }
  } catch (err) {
    summary.status = "failed";
    summary.error = err instanceof Error ? err.message : String(err);
    log(`failed: ${summary.error}`);
    await deps.notifier.notify(summary);
    return summary;
  } finally {
    rmSync(mcpConfigPath, { force: true });
    if (opts.keep) log(`kept clone(s): ${clones.join(", ")}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/** finish, scope check, indexes and checks, scope check again, commit. `committed` is false when nothing changed. */
async function finishAndCommit(
  agent: AgentDefinition,
  opts: RunOptions,
  identity: Identity,
  root: string,
  created: string[],
  output: unknown,
  checks: string[][],
  log: (line: string) => void,
): Promise<{ committed: boolean; notices: string[] }> {
  let notices: string[] = [];
  if (agent.finish) {
    try {
      notices = agent.finish({ root, today: opts.today, input: opts.input, created, output })?.notices ?? [];
    } catch (err) {
      throw new RunFailure(`finish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const notice of notices) log(`notice: ${notice}`);
  await assertScope(root, agent, "finish");
  for (const cmd of checks) {
    const r = await exec(cmd, root);
    if (r.code !== 0) {
      throw new RunFailure(`${cmd.join(" ")} failed (exit ${r.code}):\n${tail(`${r.stdout}\n${r.stderr}`)}`);
    }
    log(`ok: ${cmd.join(" ")}`);
  }
  await assertScope(root, agent, "the indexes and checks");
  return { committed: await commitAll(root, commitMessage(agent.name, created), identity), notices };
}

async function assertScope(root: string, agent: AgentDefinition, after: string): Promise<void> {
  const violations = checkFinishChanges(await status(root), agent.writes);
  if (violations.length > 0) throw new RunFailure(`write scope violated after ${after}:\n${violations.join("\n")}`);
}

/** Writes the model's files into a fresh clone; one that already exists there is a conflict. */
function replayCreated(root: string, files: Map<string, Buffer>): void {
  const clashes = [...files.keys()].filter((path) => existsSync(join(root, path)));
  if (clashes.length > 0) throw new RunFailure(`conflict: created file(s) now exist on the remote:\n${clashes.join("\n")}`);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function commitMessage(agent: string, created: string[]): string {
  if (created.length === 0) return `${agent}: update notes`;
  const subject = `${agent}: create ${created.length} file${created.length === 1 ? "" : "s"}`;
  return `${subject}\n\nCreated:\n${created.map((c) => `- ${c}`).join("\n")}\n`;
}

function readMcpConfig(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Never echo the file: it may hold credentials.
    throw new RunFailure(`cannot read the MCP config at ${path}: ${err instanceof SyntaxError ? "not valid JSON" : (err as Error).message}`);
  }
}

function readRepoFile(root: string, path: string, what: string): string {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    throw new RunFailure(`the agent's ${what} file ${path} is missing from the runner's checkout`);
  }
}

function readConfig(root: string): MeetingKitConfig {
  try {
    return loadConfig(root);
  } catch (err) {
    throw new RunFailure((err as Error).message);
  }
}

/** The repository's appendix to the agent's instructions, if meeting-kit.yaml names one; it must exist. */
function readAppendix(root: string, path: string | undefined): { path: string; text: string } | undefined {
  if (path === undefined) return undefined;
  try {
    return { path, text: readFileSync(join(root, path), "utf8") };
  } catch {
    throw new RunFailure(`meeting-kit.yaml names ${path} as instructions for this agent, but it is missing from the repository`);
  }
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
