import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../config/config.ts";
import { composeInstructions, InstructionsError, PLACEHOLDERS, renderTemplate } from "./instructions.ts";

const config = loadConfig(join(import.meta.dir, "../../examples"));

test("every placeholder renders from the config", () => {
  const text = renderTemplate(
    "{{owner.name}} ({{owner.short}}) of {{organization}}, in {{timezone}}, reads {{ calendar.id }}.",
    config,
  );
  expect(text).toBe("Alex Example (Alex) of Example Co, in America/New_York, reads work/alex@example.com.");
  expect(Object.keys(PLACEHOLDERS).sort()).toEqual(["calendar.id", "organization", "owner.name", "owner.short", "timezone"]);
});

test("an unknown placeholder throws, naming it", () => {
  expect(() => renderTemplate("Hello {{owner.email}}.", config)).toThrow(InstructionsError);
  expect(() => renderTemplate("Hello {{owner.email}}.", config)).toThrow(/\{\{owner\.email\}\}/);
});

test("a leftover {{ throws", () => {
  expect(() => renderTemplate("Broken {{owner.name", config)).toThrow(/leftover "\{\{"/);
  expect(() => renderTemplate("Nested {{{{owner.name}}}}", config)).toThrow(InstructionsError);
});

test("a config value is not re-read as a placeholder", () => {
  const odd = { ...config, organization: "{{timezone}}" };
  expect(renderTemplate("{{organization}}", odd)).toBe("{{timezone}}");
});

test("without an appendix: the rendered template alone", () => {
  expect(composeInstructions("# Kit\n\nFor {{owner.short}}.\n", config)).toBe("# Kit\n\nFor Alex.\n");
});

test("an appendix is appended under Local rules, with its path, verbatim", () => {
  const text = composeInstructions("# Kit\n\nFor {{owner.short}}.\n", config, {
    path: "docs/meeting-agents/meeting-synthesis.md",
    text: "### Names\n\n- \"Sammy\" is Sam Rivera. {{not rendered}}\n",
  });
  expect(text).toBe(
    "# Kit\n\nFor Alex.\n\n## Local rules\n\n" +
      "_From `docs/meeting-agents/meeting-synthesis.md` in this repository. These add to the instructions above; " +
      "where they are more specific, they win._\n\n" +
      "### Names\n\n- \"Sammy\" is Sam Rivera. {{not rendered}}\n",
  );
});

test("the kit's three instruction templates render with any valid config", async () => {
  const { AGENT_NAMES } = await import("./registry.ts");
  for (const name of AGENT_NAMES) {
    const { default: agent } = await import(`../agents/${name}/agent.ts`);
    const template = await Bun.file(join(import.meta.dir, "../..", agent.instructions)).text();
    const text = renderTemplate(template, config);
    expect(text).not.toContain("{{");
    expect(text).toContain("Alex");
  }
});

test("an appendix's YAML frontmatter and Sources section stay out of the prompt", () => {
  const text = composeInstructions("# Kit\n", config, {
    path: "docs/meeting-agents/x.md",
    text: "---\ntype: Guide\nstatus: stable\n---\n\n# Local rules for x\n\n### Aliases\n\n- A is B.\n\n## Sources\n\n- Somewhere.\n",
  });
  expect(text).not.toContain("status: stable");
  expect(text).not.toContain("Somewhere");
  expect(text).toContain("### Aliases\n\n- A is B.");
});
