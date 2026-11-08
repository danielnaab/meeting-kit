/** Markdown clean-up shared by the importers and capture. */

/** One blank line around each # heading outside code fences, as the vault's Markdown lint (MD022) wants. */
export function spaceHeadings(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? "" : marker;
    const heading = !fence && !marker && /^#{1,6}\s/.test(line);
    if (heading && out.length && out.at(-1)!.trim() !== "") out.push("");
    out.push(line);
    if (heading && i + 1 < lines.length && lines[i + 1]!.trim() !== "") out.push("");
  }
  return out.join("\n");
}
