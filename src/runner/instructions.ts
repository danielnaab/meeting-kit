/**
 * An agent's system-prompt instructions: the kit's template, rendered with the consuming repository's
 * meeting-kit.yaml, plus that repository's own appendix for the agent, if it names one.
 *
 * The template language is deliberately tiny: `{{key}}` for the keys in PLACEHOLDERS, nothing else. An unknown key
 * or a stray `{{` is an error, so a typo in the kit never reaches a model as literal braces. The appendix is the
 * repository's own Markdown and is appended as written, unrendered.
 */
import type { MeetingKitConfig } from "../config/config.ts";

export class InstructionsError extends Error {}

export const PLACEHOLDERS: Record<string, (c: MeetingKitConfig) => string> = {
  "owner.name": (c) => c.owner.name,
  "owner.short": (c) => c.owner.short,
  organization: (c) => c.organization,
  timezone: (c) => c.timezone,
  "calendar.id": (c) => c.calendar.id,
};

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The template with every `{{key}}` replaced. Throws InstructionsError on an unknown key or a leftover `{{`. */
export function renderTemplate(template: string, config: MeetingKitConfig): string {
  let out = "";
  let last = 0;
  const literal = (text: string) => {
    if (text.includes("{{")) {
      const line = template.slice(0, template.indexOf("{{", last)).split("\n").length;
      throw new InstructionsError(`instructions template: leftover "{{" on line ${line}`);
    }
    out += text;
  };
  for (const match of template.matchAll(PLACEHOLDER)) {
    literal(template.slice(last, match.index));
    const key = match[1]!;
    const value = Object.hasOwn(PLACEHOLDERS, key) ? PLACEHOLDERS[key]! : undefined;
    if (!value) {
      throw new InstructionsError(
        `instructions template: unknown placeholder {{${key}}}; known: ${Object.keys(PLACEHOLDERS).map((k) => `{{${k}}}`).join(", ")}`,
      );
    }
    out += value(config);
    last = match.index + match[0].length;
  }
  literal(template.slice(last));
  return out;
}

export interface Appendix {
  /** Relative to the repository root, as meeting-kit.yaml names it. */
  path: string;
  text: string;
}

/** The rendered template, then the repository's appendix under `## Local rules`. */
export function composeInstructions(template: string, config: MeetingKitConfig, appendix?: Appendix): string {
  const rendered = renderTemplate(template, config);
  if (!appendix) return rendered;
  return [
    rendered.trimEnd(),
    "",
    "## Local rules",
    "",
    `_From \`${appendix.path}\` in this repository. These add to the instructions above; where they are more specific, they win._`,
    "",
    appendix.text.trim(),
    "",
  ].join("\n");
}
