// shared/push — whether a push to the repository is worth a synthesis run: the rule of meeting_synthesis/on_push's
// filter step, kept apart from the Windmill glue so the tests can import it.
//
// The payload is a Forgejo (or GitHub-shaped) push event. A run is worth it when the push is to the default branch
// and some commit added or modified a dated meeting transcript (notebook/raw/meetings/YYYY-MM/YYYY-MM-DD-<slug>.md,
// the layout of meeting-kit's src/vault/meetings.ts). Deleting a transcript is never a reason. When the payload
// cannot show every commit's files (no list, a commit without one, or a list cut short), it fails open: the run is
// cheap when there is nothing to do, since the runner's prepare finds the pending transcripts itself.
//
// No `main`: Windmill treats this as shared logic.

const TRANSCRIPT = /^notebook\/raw\/meetings\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/;

/** A dated meeting transcript, by its path in the repository. */
export function isTranscript(path: string): boolean {
  return TRANSCRIPT.test(path);
}

export interface Decision {
  run: boolean;
  reason: string;
}

const record = (v: unknown): Record<string, any> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null);

export function shouldSynthesize(payload: unknown): Decision {
  const p = record(payload);
  if (!p) return { run: false, reason: "not a push event: the payload is not an object" };
  if (typeof p.ref !== "string") return { run: false, reason: "not a push event: no ref" };
  const branch = record(p.repository)?.default_branch;
  const want = `refs/heads/${typeof branch === "string" && branch ? branch : "main"}`;
  if (p.ref !== want) return { run: false, reason: `${p.ref} is not the default branch (${want})` };
  if (p.deleted === true) return { run: false, reason: `${p.ref} was deleted` };

  const commits: unknown[] = Array.isArray(p.commits) ? p.commits : [];
  let unseen = commits.length === 0 || (typeof p.total_commits === "number" && p.total_commits > commits.length);
  for (const c of commits) {
    const added = strings(record(c)?.added);
    const modified = strings(record(c)?.modified);
    if (!added || !modified) {
      unseen = true;
      continue;
    }
    const hit = [...added, ...modified].find(isTranscript);
    if (hit) return { run: true, reason: `transcript ${hit} added or modified on ${p.ref}` };
  }
  if (unseen) return { run: true, reason: "cannot tell which files the push changed; running in case" };
  return { run: false, reason: "no transcript added or modified" };
}
