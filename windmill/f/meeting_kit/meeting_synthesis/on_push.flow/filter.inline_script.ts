// on_push's first step: is this push worth a synthesis run? The rule is ../../shared/push.ts; the payload arrives as
// one `body` argument (the HTTP trigger wraps it). A "no" stops the flow, as skipped, before the tick runs.
import { shouldSynthesize } from "../../shared/push.ts";

export async function main(body: unknown) {
  const decision = shouldSynthesize(body);
  console.log(`${decision.run ? "run" : "skip"}: ${decision.reason}`);
  return decision;
}
