// shared/review — what a flow makes of the runner's results: which steps failed, which notices the owner should
// hear about, and the one alert and one error a run ends with.
//
// A step that runs f/meeting_kit/agent/run returns the runner's one-line summary (src/runner/runner.ts
// RunSummary: agent, status, created, cost, output, notices?, error?) plus the adapter's commit and labels. A failed
// step's result is Windmill's `{error: {..., step_id}}`; a skipped step's result is the previous step's.
//
// How the owner hears about a run:
//   - a FAILED run fails its job (the runner exits 1), and the host's failed-job alerting picks it up;
//   - a NOTICE from a run that succeeded (a recording judged not a work meeting) goes through the host's
//     f/infra/alert script, as one MeetingAgentNotice per flow run.
//
// No `main`: Windmill treats this as shared logic. The flows' inline steps import it; the tests in windmill/tests/ do too.

/** The alert name; the host's alert runbook should have a section for it. */
export const NOTICE_ALERT = "MeetingAgentNotice";

const MAX_MESSAGE = 300;
const MAX_DESCRIPTION = 2000;
const MORE = "(more in the run's result)";

const record = (r: unknown): Record<string, any> | null => (r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, any>) : null);

/** A Windmill step error, or a runner summary that says it failed. */
export function isFailure(r: unknown): boolean {
  const o = record(r);
  return o !== null && ("error" in o || o.status === "failed");
}

/** A step failure as one line: Windmill's "exit code ..., last log lines:" message keeps the lines that say why. */
export function failureMessage(r: unknown): string {
  const o = record(r);
  const raw = o?.error?.message ?? o?.error ?? "";
  return String(raw).replace(/\s*\n\s*/g, " / ").trim().slice(0, MAX_MESSAGE);
}

/** The notices in a runner summary: non-empty strings only. */
export function runnerNotices(r: unknown): string[] {
  const notices = record(r)?.notices;
  return Array.isArray(notices) ? notices.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
}

export interface Review {
  problems: string[];
  notices: string[];
}

/**
 * workday_start's closing check. The steps before it carry on after an error and the loop skips failures, so every
 * briefing gets its chance; the check then fails the flow once, naming each failure. An error counts against the step
 * it names: when the gate fails, the skipped triage carries the gate's error, and that is still the gate's failure.
 */
export function workdayReview(gate: unknown, triage: unknown, briefings: unknown): Review & { briefings: number } {
  const problems: string[] = [];
  if (isFailure(gate)) problems.push(`calendar gate failed: ${failureMessage(gate)}`);
  const triageStep = record(triage)?.error?.step_id ?? "triage";
  if (isFailure(triage) && triageStep === "triage") problems.push(`triage failed: ${failureMessage(triage)}`);
  const runs = Array.isArray(briefings) ? briefings : [];
  const bad = runs.filter(isFailure);
  if (bad.length) problems.push(`${bad.length} of ${runs.length} briefing runs failed: ${bad.map(failureMessage).join(" | ")}`);
  const notices = [...(triage === gate ? [] : runnerNotices(triage)), ...runs.flatMap(runnerNotices)];
  return { briefings: runs.length, problems, notices };
}

export interface Alert {
  name: string;
  summary: string;
  description: string;
  severity: "warning";
  labels: Record<string, string>;
}

/**
 * One alert for a run's notices, or null. Labelled by flow and job: Alertmanager deduplicates on labels, and two runs'
 * notices must never merge into one push.
 */
export function noticeAlert(notices: string[], flow: string, jobId: string | undefined): Alert | null {
  if (notices.length === 0) return null;
  const summary = notices.length === 1 ? `Meeting agents: ${notices[0]}` : `Meeting agents: ${notices.length} notices from ${flow}`;
  const full = notices.map((n) => `- ${n}`).join("\n");
  const description = full.length <= MAX_DESCRIPTION ? full : `${full.slice(0, MAX_DESCRIPTION - MORE.length - 1)}\n${MORE}`;
  return { name: NOTICE_ALERT, summary, description, severity: "warning", labels: { flow, ...(jobId ? { job: jobId } : {}) } };
}

/** f/infra/alert's main: (name, summary, description, severity, labels). */
export type SendAlert = (name: string, summary: string, description: string, severity: "warning", labels: Record<string, string>) => Promise<unknown>;

/**
 * The end of a flow run: send the notices, then throw the problems. A notice that can't be sent fails the run with
 * the notice in the error, so WindmillJobFailed carries it instead.
 */
export async function deliver(review: Review, flow: string, jobId: string | undefined, send: SendAlert): Promise<{ notices: number }> {
  const problems = [...review.problems];
  const alert = noticeAlert(review.notices, flow, jobId);
  if (alert) {
    try {
      await send(alert.name, alert.summary, alert.description, alert.severity, alert.labels);
    } catch (err) {
      const n = review.notices.length;
      problems.push(`could not send ${n} notice${n === 1 ? "" : "s"} (${err instanceof Error ? err.message : String(err)}): ${review.notices.join(" | ")}`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return { notices: review.notices.length };
}
