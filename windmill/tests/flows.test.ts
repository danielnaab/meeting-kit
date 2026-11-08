// The shape of the Windmill flows and schedules, as `meeting-kit render` writes them from examples/meeting-kit.yaml
// (./rendered.ts). They reach Windmill only through the host's sync, so a typo here is a failed run on the owner's
// phone; these catch the ones a file can show. What Windmill itself does with them still needs one run on a
// throwaway Windmill.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAMES } from "../../src/runner/registry.ts";
import { config, F, FOLDER, ROOT, TEMPLATES } from "./rendered.ts";

const RUN = `f/${FOLDER}/agent/run`;
const TICK = `f/${FOLDER}/meeting_synthesis/tick`;

const yaml = async (path: string) => Bun.YAML.parse(await Bun.file(path).text()) as any;
const evalExpr = (expr: string, ctx: Record<string, unknown>) =>
  new Function(...Object.keys(ctx), `return (${expr});`)(...Object.values(ctx));

/** Every module in a flow, loops and branches included. */
function* all(ms: any[]): Generator<any> {
  for (const m of ms ?? []) {
    yield m;
    yield* all(m.value?.modules);
    for (const b of m.value?.branches ?? []) yield* all(b.modules);
    if (m.value?.default) yield* all(m.value.default);
  }
}

async function flows(): Promise<{ file: string; flow: any }[]> {
  const out = [];
  for await (const file of new Bun.Glob("**/flow.yaml").scan(ROOT)) out.push({ file, flow: await yaml(join(ROOT, file)) });
  return out;
}

async function schedules(): Promise<{ file: string; schedule: any }[]> {
  const out = [];
  for await (const file of new Bun.Glob("**/*.schedule.yaml").scan(ROOT)) out.push({ file, schedule: await yaml(join(ROOT, file)) });
  return out;
}

describe("the runner script", async () => {
  const meta = await yaml(`${F}/agent/run.script.yaml`);
  const body = await Bun.file(`${F}/agent/run.sh`).text();

  test("runs on the agent worker, under a Windmill limit", () => {
    expect(meta.kind).toBe("script");
    expect(meta.tag).toBe("agent");
    expect(meta.timeout).toBe(5400);
  });
  test("agent and dry_run are dropdowns: the runner's agents, and false/true", () => {
    expect(meta.schema.properties.agent.enum).toEqual([...AGENT_NAMES]);
    expect(meta.schema.properties.dry_run.enum).toEqual(["false", "true"]);
  });
  test("its schema is the script's arguments, in order: agent, input, dry_run", () => {
    expect(Object.keys(meta.schema.properties).sort()).toEqual(["agent", "dry_run", "input"]);
    expect(meta.schema.required).toEqual(["agent"]);
    expect(body).toMatch(/^agent="\$1"\ninput="\$\{2:-\}"\ndry_run="\$\{3:-false\}"$/m);
  });
});

describe("every agent step", async () => {
  const steps: { where: string; m: any }[] = [];
  for (const { file, flow } of await flows()) for (const m of all(flow.value.modules)) if (m.value?.path === RUN) steps.push({ where: `${file}#${m.id}`, m });
  for (const { file, schedule } of await schedules()) if (schedule.script_path === RUN) steps.push({ where: file, m: { value: { input_transforms: { agent: { type: "static", value: schedule.args.agent } } } } });

  test("there are some", () => {
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });
  test("names an agent the runner knows, statically", () => {
    for (const { where, m } of steps) {
      expect(m.value.input_transforms.agent?.type, where).toBe("static");
      expect(AGENT_NAMES, where).toContain(m.value.input_transforms.agent.value);
    }
  });
  test("has its own Windmill timeout", () => {
    for (const { where, m } of steps.filter((s) => s.m.id)) expect(m.timeout?.type, where).toBe("static");
  });
});

describe("meeting synthesis: the tick", async () => {
  const flow = await yaml(`${F}/meeting_synthesis/tick.flow/flow.yaml`);
  const modules: any[] = flow.value.modules;
  const step = (id: string) => modules.find((m) => m.id === id);
  const schedule = await yaml(`${F}/meeting_synthesis/tick.schedule.yaml`);

  test("synthesize, then notify", () => {
    expect(modules.map((m) => m.id)).toEqual(["synthesize", "notify"]);
    expect(step("synthesize").value.input_transforms.agent).toEqual({ type: "static", value: "meeting-synthesis" });
    expect(step("synthesize").timeout).toEqual({ type: "static", value: 5400 });
  });
  test("no gate: the runner's prepare is the queue, and a run with nothing to do shows as skipped", () => {
    const s = step("synthesize");
    expect(s.continue_on_error).toBeUndefined();
    expect(s.stop_after_if.skip_if_stopped).toBe(true);
    const stop = (result: unknown) => evalExpr(s.stop_after_if.expr, { result });
    expect(stop({ status: "nothing-to-do" })).toBe(true);
    for (const status of ["pushed", "no-changes", "dry-run"]) expect(stop({ status })).toBe(false);
  });
  test("notify reads the synthesis result", () => {
    expect(step("notify").value.input_transforms.result).toEqual({ type: "javascript", expr: "results.synthesize" });
  });
  test("fires on the configured cron, in the owner's time zone, one at a time", () => {
    expect(schedule.script_path).toBe(TICK);
    expect(schedule.is_flow).toBe(true);
    expect(schedule.schedule).toBe(config.windmill.schedules.synthesis);
    expect(schedule.timezone).toBe(config.timezone);
    expect(schedule.no_flow_overlap).toBe(true);
  });
  test("there is no separate sweep: every tick is a full run", () => {
    expect(existsSync(`${F}/meeting_synthesis/sweep.schedule.yaml`)).toBe(false);
  });
});

describe("workday start", async () => {
  const flow = await yaml(`${F}/workday_start.flow/flow.yaml`);
  const modules: any[] = flow.value.modules;
  const step = (id: string) => modules.find((m) => m.id === id);
  const schedule = await yaml(`${F}/workday_start.schedule.yaml`);

  test("gate, triage, briefings, check, in that order", () => {
    expect(modules.map((m) => m.id)).toEqual(["calendar_gate", "triage", "briefings", "check"]);
  });
  test("nothing stops it early, and every step before check carries on after an error", () => {
    for (const m of all(modules)) {
      expect(m.stop_after_if, m.id).toBeUndefined();
      expect(m.stop_after_all_iters_if, m.id).toBeUndefined();
    }
    for (const m of modules.slice(0, -1)) expect(m.continue_on_error, m.id).toBe(true);
    expect(step("check").continue_on_error).toBeUndefined();
    expect(step("briefings").value.skip_failures).toBe(true);
    expect(step("briefings").value.parallel).toBe(false);
  });
  test("the triage is skipped only when the gate found nothing to triage", () => {
    const skip = (gate: unknown) => evalExpr(step("triage").skip_if.expr, { results: { calendar_gate: gate } });
    expect(skip({ meetings: [] })).toBe(true);
    expect(skip({ error: { message: "HTTP 502" } })).toBe(true);
    expect(skip(undefined)).toBe(true);
    expect(skip({ meetings: [{ uid: "u1" }] })).toBe(false);
  });
  test("the triage is given the gate's whole answer: the day shape meeting-triage takes", () => {
    const gate = { date: "2026-11-09", calendar: "c", meetings: [{ uid: "u1" }], dropped: [], stale_calendars: [], omitted: 0 };
    const input = evalExpr(step("triage").value.input_transforms.input.expr, { results: { calendar_gate: gate } });
    expect(JSON.parse(input)).toEqual(gate);
    expect(step("triage").value.input_transforms.agent).toEqual({ type: "static", value: "meeting-triage" });
    expect(step("triage").timeout).toEqual({ type: "static", value: 900 });
  });
  test("the loop runs over the triage's structured output, and over nothing when there is none", () => {
    const iter = (triage: unknown) => evalExpr(step("briefings").value.iterator.expr, { results: { triage } });
    expect(iter({ output: { meetings: [{ uid: "u1" }, { uid: "u2" }] } })).toEqual([{ uid: "u1" }, { uid: "u2" }]);
    expect(iter({ output: { meetings: [] } })).toEqual([]);
    expect(iter({ output: null })).toEqual([]);
    expect(iter(null)).toEqual([]);
    expect(iter({ error: { message: "exit code 1" } })).toEqual([]);
  });
  test("each briefing is given its meeting and the day's date", () => {
    const briefing = step("briefings").value.modules[0];
    expect(briefing.value.input_transforms.agent).toEqual({ type: "static", value: "meeting-briefing" });
    expect(briefing.timeout).toEqual({ type: "static", value: 1500 });
    const meeting = { calendar: "c", uid: "u1", start: "2026-11-09T10:00-06:00", title: "Sprint review", why: "w" };
    const input = evalExpr(briefing.value.input_transforms.input.expr, {
      results: { calendar_gate: { date: "2026-11-09" } }, flow_input: { iter: { value: meeting, index: 0 } },
    });
    expect(JSON.parse(input)).toEqual({ date: "2026-11-09", ...meeting });
  });
  test("the check reads the gate, the triage and the loop", () => {
    const t = step("check").value.input_transforms;
    expect([t.gate.expr, t.triage.expr, t.briefings.expr]).toEqual(["results.calendar_gate", "results.triage", "results.briefings"]);
  });
  test("fires on the configured cron, in the owner's time zone, one at a time", () => {
    expect(schedule.script_path).toBe(`f/${FOLDER}/workday_start`);
    expect(schedule.is_flow).toBe(true);
    expect(schedule.schedule).toBe(config.windmill.schedules.workdayStart);
    expect(schedule.timezone).toBe(config.timezone);
    expect(schedule.no_flow_overlap).toBe(true);
  });
  test("reads the configured calendar through the configured calendar server, by default and on schedule", () => {
    expect(schedule.args.calendar).toBe(config.calendar.id);
    expect(schedule.args.calendar_mcp_url).toBe(config.mcp.servers.calendar!.url);
    expect(flow.schema.properties.calendar.default).toBe(config.calendar.id);
    expect(flow.schema.properties.calendar_mcp_url.default).toBe(config.mcp.servers.calendar!.url);
  });
});

describe("every schedule", async () => {
  const all = await schedules();

  test("there are two", () => {
    expect(all.map((s) => s.file).sort()).toEqual([
      `f/${FOLDER}/meeting_synthesis/tick.schedule.yaml`,
      `f/${FOLDER}/workday_start.schedule.yaml`,
    ]);
  });
  // Windmill applies no flow defaults to a scheduled run: an argument a schedule leaves out is null.
  test("passes every argument of its flow", async () => {
    for (const { file, schedule } of all) {
      const flowFile = join(ROOT, `${schedule.script_path}.flow`, "flow.yaml");
      expect(existsSync(flowFile), file).toBe(true);
      const flow = await yaml(flowFile);
      expect(Object.keys(schedule.args).sort(), file).toEqual(Object.keys(flow.schema.properties).sort());
    }
  });
  test("is labelled with its use case and in the folder's own path", () => {
    for (const { file, schedule } of all) {
      expect(schedule.script_path.startsWith(`f/${FOLDER}/`), file).toBe(true);
      expect(schedule.labels?.length, file).toBeGreaterThan(0);
      expect(schedule.enabled, file).toBe(true);
    }
  });
});

describe("push-triggered synthesis", async () => {
  const flow = await yaml(`${F}/meeting_synthesis/on_push.flow/flow.yaml`);
  const modules: any[] = flow.value.modules;
  const step = (id: string) => modules.find((m) => m.id === id);
  const trigger = await yaml(`${F}/meeting_synthesis/on_push.http_trigger.yaml`);
  const auth = await yaml(`${F}/meeting_synthesis/webhook_auth.resource.yaml`);

  test("filter, then the tick as a subflow", () => {
    expect(modules.map((m) => m.id)).toEqual(["filter", "synthesize"]);
    expect(step("synthesize").value).toMatchObject({ type: "flow", path: TICK });
    expect(existsSync(join(ROOT, `${TICK}.flow`, "flow.yaml"))).toBe(true);
  });
  test("the filter reads the wrapped payload, and a no stops the flow as skipped", () => {
    const f = step("filter");
    expect(f.value.input_transforms.body).toEqual({ type: "javascript", expr: "flow_input.body" });
    expect(Object.keys(flow.schema.properties)).toEqual(["body"]);
    expect(f.stop_after_if.skip_if_stopped).toBe(true);
    const stop = (result: unknown) => evalExpr(f.stop_after_if.expr, { result });
    expect(stop({ run: false, reason: "x" })).toBe(true);
    expect(stop({ run: true, reason: "x" })).toBe(false);
  });
  test("the subflow passes every argument of the tick", async () => {
    const tick = await yaml(join(ROOT, `${TICK}.flow`, "flow.yaml"));
    expect(Object.keys(step("synthesize").value.input_transforms).sort()).toEqual(Object.keys(tick.schema.properties).sort());
    expect(step("synthesize").value.input_transforms.dry_run).toEqual({ type: "static", value: "false" });
  });
  test("the filter step is the shared rule", async () => {
    const { main } = await import(`${F}/meeting_synthesis/on_push.flow/filter.inline_script.ts`);
    const ref = "refs/heads/main";
    const t = "notebook/raw/meetings/2026-11/2026-11-08-x.md";
    expect((await main({ ref, commits: [{ added: [t], modified: [] }], total_commits: 1 })).run).toBe(true);
    expect((await main({ ref, commits: [{ added: [], modified: [], removed: [t] }], total_commits: 1 })).run).toBe(false);
  });
  test("the HTTP route runs the flow asynchronously, signed with the folder's webhook_secret", () => {
    expect(trigger).toMatchObject({
      script_path: `f/${FOLDER}/meeting_synthesis/on_push`, is_flow: true, route_path: config.windmill.webhook!.route,
      http_method: "post", is_async: true, request_type: "async", authentication_method: "signature",
      authentication_resource_path: `f/${FOLDER}/meeting_synthesis/webhook_auth`, wrap_body: true,
      workspaced_route: false, raw_string: false,
    });
    expect(existsSync(join(ROOT, `${trigger.authentication_resource_path}.resource.yaml`))).toBe(true);
    expect(auth.resource_type).toBe("signature_auth");
    expect(auth.value.secret_key).toBe(`$var:f/${FOLDER}/webhook_secret`);
    expect(auth.value.authentication_config.signature_header_name).toBe(config.windmill.webhook!.signatureHeader);
  });
});

describe("the tree", () => {
  test("tests and docs stay outside f/, so the host's sync never pushes them", async () => {
    for (const root of [ROOT, join(TEMPLATES, "../..")]) {
      for await (const file of new Bun.Glob("f/**/*").scan(root)) {
        expect(file.endsWith(".test.ts") || file.endsWith(".md"), file).toBe(false);
      }
    }
  });
  test("the templates and the rendered tree name no particular person, organization or host", async () => {
    const names = /flexion|daniel|crushingpennies|dnaab|chicago|metamcp/i;
    const kit = join(TEMPLATES, "../..");
    const files = [
      ...[...new Bun.Glob("f/**/*").scanSync(kit)].map((f) => join(kit, f)),
      join(kit, "README.template.md"),
      join(kit, "wmill.yaml"),
      ...[...new Bun.Glob("**/*").scanSync(ROOT)].map((f) => join(ROOT, f)),
    ];
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(names);
  });
});
