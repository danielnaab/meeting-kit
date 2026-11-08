// workday_start's last step. The steps before it are continue_on_error and the briefing loop is skip_failures, so
// every briefing gets its chance, and the flow would then succeed whatever happened. Failed-job alerting only sees
// the flow's own status, so this step fails the flow once, naming each failure, after sending any notices the runs
// carried (MeetingAgentNotice, through the host's f/infra/alert). The rule is ../shared/review.ts.
import { main as alert } from "/f/infra/alert.ts";
import { deliver, workdayReview } from "../shared/review.ts";

export async function main(gate: unknown, triage: unknown, briefings: unknown) {
  const review = workdayReview(gate, triage, briefings);
  const jobId = process.env.WM_ROOT_FLOW_JOB_ID ?? process.env.WM_FLOW_JOB_ID;
  const { notices } = await deliver(review, "f/meeting_kit/workday_start", jobId, alert);
  return { briefings: review.briefings, notices };
}
