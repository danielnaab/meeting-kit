/**
 * The contract between the runner (src/runner/) and each meeting agent (src/agents/<name>/).
 *
 * An agent runs headless (`claude -p`) in a fresh clone of this repository, with `--restricted` (no Bash, no
 * WebFetch, file tools confined to the clone), only the tools in `tools`, and only the MCP servers in
 * `mcpServers`. The model only CREATES files: it never edits or deletes an existing note. Everything
 * deterministic (daily-note lines, indexes, checks, commit, push) is code: `prepare` before the model, `finish`
 * after it. The runner rejects the run, and pushes nothing, if any change falls outside `writes`.
 */

import type { Meeting } from "../meetings/meetings.ts";

/** Paths are inside the clone, relative to its root ("notebook/records/meetings/2026-11/x.md"). Globs use Bun.Glob. */
export interface WriteScope {
  /** New files the model (or `finish`) may create. */
  create: string[];
  /** Files that `finish` may change, or create when missing (the model never may). Generated folder index.md files are always allowed. */
  modify: string[];
}

/** The meeting a run was given with `--meeting ID`, as the calendar has it now (../meetings/meetings.ts). */
export interface RunMeeting extends Meeting {
  /** The day the ID names (YYYY-MM-DD). */
  date: string;
  /** --why: why this meeting gets a briefing (the triage's one line), when the caller has one. */
  why?: string;
}

export interface PrepareContext {
  root: string; // the clone
  today: string; // YYYY-MM-DD, local
  /** --meeting, resolved against the calendar: only for an agent that `takes: "meeting"`. */
  meeting?: RunMeeting;
  /** The --input JSON, if any: only for an agent that `takes: "input"` (meeting-triage: the calendar gate's day). */
  input?: unknown;
}

export interface Prepared {
  prompt: string; // the user prompt for `claude -p`; the instructions file is the system prompt
}

export interface FinishContext extends PrepareContext {
  created: string[]; // files the model created, relative to the clone root
  output?: unknown; // structured output, when the agent has a `schema`
}

export interface FinishResult {
  notices?: string[];
}

export interface AgentDefinition {
  name: string; // "meeting-synthesis"
  /**
   * What the agent takes from the command line, besides the common options: `"meeting"`, a required `--meeting ID`
   * (with an optional `--why`); `"input"`, an optional `--input JSON`; absent, neither. Anything else is a usage
   * error before the run starts.
   */
  takes?: "meeting" | "input";
  /** Instructions, relative to the repository root: appended to the system prompt. */
  instructions: string;
  model?: string; // "sonnet"; undefined means the profile default
  /** Claude Code --allowedTools entries: Read, Grep, Glob, Write, mcp__<server>__<tool>, ... */
  tools: string[];
  /** Keys of the MCP config the runner is given (e.g. "calendar", "records"); every other server is not loaded. */
  mcpServers: string[];
  writes: WriteScope;
  /** A JSON Schema file (relative to the repository root): the run answers in that shape (--json-schema). */
  schema?: string;
  /** What the model is asked to do, or null when there is nothing to do (the model is not invoked). */
  prepare(ctx: PrepareContext): Prepared | null;
  /**
   * Deterministic follow-up in the clone after the model ran, such as daily-note lines for created notes. Notices
   * are things the owner should hear about (a recording not synthesized); the runner puts them in its summary.
   */
  finish?(ctx: FinishContext): FinishResult | void;
}
