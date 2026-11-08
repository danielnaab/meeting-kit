// The tick's last step: pass on what the synthesis run said the owner should hear about (a recording judged not a work
// meeting), as one MeetingAgentNotice through the host's f/infra/alert. It runs only after a run that did something:
// one with nothing to do stops the flow as skipped, and a failed one fails it.
import { main as alert } from "/f/infra/alert.ts";
import { deliver, runnerNotices } from "../../shared/review.ts";

export async function main(result: unknown) {
  const jobId = process.env.WM_ROOT_FLOW_JOB_ID ?? process.env.WM_FLOW_JOB_ID;
  return deliver({ problems: [], notices: runnerNotices(result) }, "f/meeting_kit/meeting_synthesis/tick", jobId, alert);
}
