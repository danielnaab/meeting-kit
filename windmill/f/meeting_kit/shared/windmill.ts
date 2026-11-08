// shared/windmill — the one Windmill API call the Bun steps need: a variable's value, with the job's own token.
//
// A plain request to Windmill's variables API, so the steps carry no npm dependency (no
// windmill-client, no lockfile to resolve on the workers). Bun jobs get the server's internal URL as BASE_URL, other
// runtimes as BASE_INTERNAL_URL.
//
// No `main`: Windmill treats this as shared logic.

export async function variable(path: string): Promise<string> {
  const base = process.env.BASE_INTERNAL_URL ?? process.env.BASE_URL;
  const res = await fetch(`${base}/api/w/${process.env.WM_WORKSPACE}/variables/get_value/${path}`, {
    headers: { Authorization: `Bearer ${process.env.WM_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`variable ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as string;
}
