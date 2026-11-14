import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, FinishContext } from "../agents/types.ts";
import type { ModelRequest, ModelResult, ModelRunner } from "./claude.ts";
import type { RunOptions } from "./cli.ts";
import { AgentRegistry } from "./registry.ts";
import { DEFAULT_CHECKS, defaultChecks, type RunSummary, runAgent } from "./runner.ts";
import { configYaml, pushConcurrent, remoteFile, remoteLog, seedRemote, tempDir, writeFile } from "./testkit.ts";

/** Any agent the config enables; the definition itself is the fixture's. */
const AGENT = "meeting-synthesis";
const DAILY = "notebook/records/daily/2026-11/2026-11-06.md";
/** The runner's own checkout: instructions and schemas come from here, with the agent code, not from the clone. */
function codeCheckout(): string {
  const root = tempDir();
  writeFile(root, "agents/fixture.md", "# Fixture instructions\n");
  writeFile(root, "agents/fixture.schema.json", '{"type":"object"}\n');
  return root;
}
const SEED = {
  "meeting-kit.yaml": configYaml(),
  "README.md": "Fixture repository\n",
  ".gitignore": ".local/\n",
  [DAILY]: "# 2026-11-06\n\n## Work\n",
};

function fixtureAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: AGENT,
    instructions: "agents/fixture.md",
    model: "sonnet",
    tools: ["Read", "Write"],
    mcpServers: [],
    writes: { create: ["notebook/out/*.md"], modify: ["notebook/records/daily/*/*.md"] },
    prepare: ({ today }) => ({ prompt: `Write the notes for ${today}.` }),
    finish: ({ root, created }: FinishContext) => {
      const daily = join(root, DAILY);
      writeFileSync(daily, readFileSync(daily, "utf8") + created.map((c) => `- ${c}\n`).join(""));
    },
    ...overrides,
  };
}

/** A model that writes the given files into the clone; `during` runs while it "thinks". */
function fakeModel(files: Record<string, string>, result: Partial<ModelResult> = {}, during?: () => void) {
  const requests: ModelRequest[] = [];
  const model: ModelRunner = {
    async run(request) {
      requests.push(request);
      for (const [path, content] of Object.entries(files)) writeFile(request.cwd, path, content);
      during?.();
      return { ok: true, cost: 0.25, turns: 4, ...result };
    },
  };
  return { model, requests };
}

interface Harness {
  remote: string;
  summary: RunSummary;
  notified: RunSummary[];
  logs: string[];
  printed: string[];
}

async function run(
  agent: AgentDefinition,
  model: ModelRunner,
  opts: Partial<RunOptions> & { checks?: string[][]; remote?: string; codeRoot?: string } = {},
): Promise<Harness> {
  const remote = opts.remote ?? seedRemote(SEED);
  const notified: RunSummary[] = [];
  const logs: string[] = [];
  const printed: string[] = [];
  const summary = await runAgent(
    {
      agent: agent.name,
      dryRun: false,
      keep: false,
      today: "2026-11-06",
      ...opts,
      remote,
    },
    {
      registry: new AgentRegistry({ [agent.name]: async () => agent }),
      codeRoot: opts.codeRoot ?? codeCheckout(),
      model,
      notifier: { notify: (s) => void notified.push(s) },
      checks: opts.checks ?? [["true"]],
      log: (line) => void logs.push(line),
      print: (text) => void printed.push(text),
    },
  );
  return { remote, summary, notified, logs, printed };
}

const commits = (remote: string) => remoteLog(remote).length;

describe("nothing to do", () => {
  test("prepare null: no model call, no push", async () => {
    const { model, requests } = fakeModel({});
    const h = await run(fixtureAgent({ prepare: () => null }), model);
    expect(h.summary).toEqual({ agent: AGENT, status: "nothing-to-do", created: [], cost: null, output: null });
    expect(requests).toHaveLength(0);
    expect(commits(h.remote)).toBe(1);
    expect(h.logs).toContain("nothing to do");
    expect(h.notified).toHaveLength(0);
  });
});

describe("a successful run", () => {
  test("model creates, finish appends, checks pass, commit and push", async () => {
    const marker = join(tempDir(), "checks.log");
    const { model, requests } = fakeModel({ "notebook/out/2026-11-06-sync.md": "# Sync\n" });
    const h = await run(fixtureAgent(), model, {
      checks: [
        ["sh", "-c", `echo index $(pwd) >> ${marker}`],
        ["sh", "-c", `echo check >> ${marker}`],
      ],
    });
    expect(h.summary).toEqual({
      agent: AGENT,
      status: "pushed",
      created: ["notebook/out/2026-11-06-sync.md"],
      cost: 0.25,
      output: null,
    });
    expect(remoteFile(h.remote, "notebook/out/2026-11-06-sync.md")).toBe("# Sync\n");
    expect(remoteFile(h.remote, DAILY)).toBe("# 2026-11-06\n\n## Work\n- notebook/out/2026-11-06-sync.md\n");
    expect(remoteLog(h.remote, "%an <%ae>|%s")[0]).toBe("Test Agents <agents@example.invalid>|meeting-synthesis: create 1 file");
    expect(remoteLog(h.remote, "%b").join("\n")).toContain("Created:\n- notebook/out/2026-11-06-sync.md");

    // The checks ran in the clone, in order; the clone is gone afterwards.
    const clone = requests[0]!.cwd;
    expect(readFileSync(marker, "utf8")).toBe(`index ${clone}\ncheck\n`);
    expect(existsSync(clone)).toBe(false);
    expect(h.logs.some((l) => /turns=4 cost_usd=0.25/.test(l))).toBe(true);
  });

  test("finish notices go into the summary and the log", async () => {
    const { model } = fakeModel({ "notebook/out/skip.md": "skip\n" });
    const h = await run(fixtureAgent({ finish: () => ({ notices: ["Not synthesized: notebook/out/skip.md"] }) }), model);
    expect(h.summary.status).toBe("pushed");
    expect(h.summary.notices).toEqual(["Not synthesized: notebook/out/skip.md"]);
    expect(h.logs).toContain("notice: Not synthesized: notebook/out/skip.md");
    expect(h.notified).toHaveLength(0);
  });

  test("a check's ignored cache files are not changes", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const h = await run(fixtureAgent(), model, { checks: [["sh", "-c", "mkdir -p .local && echo c > .local/cache"]] });
    expect(h.summary.status).toBe("pushed");
    expect(remoteFile(h.remote, ".local/cache")).toBeNull();
  });

  test("the model gets the prompt, instructions, schema, and only its MCP servers", async () => {
    const mcpDir = tempDir();
    const mcpConfigPath = join(mcpDir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { calendar: { url: "c" }, finance: { url: "f" } } }));
    let mcpSeen: unknown;
    let mcpPath = "";
    const model: ModelRunner = {
      async run(request) {
        mcpPath = request.args[request.args.indexOf("--mcp-config") + 1]!;
        mcpSeen = JSON.parse(readFileSync(mcpPath, "utf8"));
        return { ok: true, output: { brief: ["e1"] }, cost: 0.1, turns: 1 };
      },
    };
    let finishOutput: unknown;
    const agent = fixtureAgent({
      mcpServers: ["calendar"],
      schema: "agents/fixture.schema.json",
      prepare: ({ input }) => ({ prompt: `Events: ${JSON.stringify(input)}` }),
      finish: ({ output }) => {
        finishOutput = output;
      },
    });
    const h = await run(agent, model, { mcpConfigPath, input: [{ id: "e1" }] });
    expect(h.summary).toEqual({ agent: AGENT, status: "no-changes", created: [], cost: 0.1, output: { brief: ["e1"] } });
    expect(finishOutput).toEqual({ brief: ["e1"] });
    expect(mcpSeen).toEqual({ mcpServers: { calendar: { url: "c" } } });
    expect(existsSync(mcpPath)).toBe(false);
    expect(commits(h.remote)).toBe(1);
  });

  test("an MCP server the agent lists but the MCP config lacks is simply absent", async () => {
    const mcpConfigPath = join(tempDir(), "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { calendar: { url: "c" } } }));
    let mcpSeen: unknown;
    const model: ModelRunner = {
      async run(request) {
        mcpSeen = JSON.parse(readFileSync(request.args[request.args.indexOf("--mcp-config") + 1]!, "utf8"));
        return { ok: true, cost: 0.1, turns: 1 };
      },
    };
    const h = await run(fixtureAgent({ mcpServers: ["calendar", "records"], finish: undefined }), model, { mcpConfigPath });
    expect(h.summary.status).toBe("no-changes");
    expect(mcpSeen).toEqual({ mcpServers: { calendar: { url: "c" } } });
  });

  test("no MCP config at all: the agent runs with no servers", async () => {
    let mcpSeen: unknown;
    const model: ModelRunner = {
      async run(request) {
        mcpSeen = JSON.parse(readFileSync(request.args[request.args.indexOf("--mcp-config") + 1]!, "utf8"));
        return { ok: true, cost: 0.1, turns: 1 };
      },
    };
    const h = await run(fixtureAgent({ mcpServers: ["records"], finish: undefined }), model);
    expect(h.summary.status).toBe("no-changes");
    expect(mcpSeen).toEqual({ mcpServers: {} });
  });

  test("instructions: the kit's template rendered with the config, then the repository's appendix", async () => {
    const code = codeCheckout();
    writeFile(code, "agents/fixture.md", "# Fixture\n\nFor {{owner.name}} ({{owner.short}}) at {{organization}}, {{timezone}}, {{calendar.id}}.\n");
    const remote = seedRemote({
      ...SEED,
      "meeting-kit.yaml": configYaml({ instructions: { [AGENT]: "docs/agents/synthesis.md" } }),
      "docs/agents/synthesis.md": "### Names\n\n- \"Sammy\" is Sam Rivera.\n",
    });
    const { model, requests } = fakeModel({});
    await run(fixtureAgent({ finish: undefined }), model, { codeRoot: code, remote });
    const instructions = requests[0]!.args[requests[0]!.args.indexOf("--append-system-prompt") + 1]!;
    expect(instructions).toStartWith("# Fixture\n\nFor Sam Rivera (Sam) at Example Co, America/Denver, work/sam@example.com.\n\n## Local rules\n");
    expect(instructions).toContain("`docs/agents/synthesis.md`");
    expect(instructions).toEndWith("### Names\n\n- \"Sammy\" is Sam Rivera.\n");
  });

  test("the claude args carry the prompt, instructions content, and schema content", async () => {
    const { model, requests } = fakeModel({});
    await run(fixtureAgent({ schema: "agents/fixture.schema.json", finish: undefined }), model);
    const args = requests[0]!.args;
    expect(args.slice(0, 5)).toEqual([
      "-p",
      "Write the notes for 2026-11-06.",
      "--restricted",
      "--append-system-prompt",
      "# Fixture instructions\n",
    ]);
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}\n');
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Write");
    // The MCP config lives outside the clone, where the model's file tools cannot reach it.
    expect(args[args.indexOf("--mcp-config") + 1]!.startsWith(requests[0]!.cwd)).toBe(false);
  });
});

describe("failures push nothing and notify", () => {
  test("instructions missing from the runner's checkout", async () => {
    const { model, requests } = fakeModel({});
    const h = await run(fixtureAgent(), model, { codeRoot: tempDir() });
    expect(h.summary.status).toBe("failed");
    expect(h.summary.error).toMatch(/instructions file agents\/fixture\.md is missing from the runner's checkout/);
    expect(requests).toHaveLength(0);
  });

  test("the model modifies a tracked file", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n", "README.md": "defaced\n" });
    const h = await run(fixtureAgent(), model);
    expect(h.summary.status).toBe("failed");
    expect(h.summary.error).toMatch(/README\.md \(modified by the model\)/);
    expect(h.notified).toEqual([h.summary]);
    expect(commits(h.remote)).toBe(1);
  });

  test("the model creates outside writes.create", async () => {
    const { model } = fakeModel({ "notebook/tasks/x.md": "x\n" });
    const h = await run(fixtureAgent(), model);
    expect(h.summary.error).toMatch(/notebook\/tasks\/x\.md \(created outside writes\.create\)/);
    expect(commits(h.remote)).toBe(1);
  });

  test("the model writes an ignored file", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n", ".local/loot.txt": "x\n" });
    const h = await run(fixtureAgent(), model);
    expect(h.summary.error).toMatch(/\.local\/loot\.txt \(created outside writes\.create\)/);
  });

  test("finish modifies outside writes.modify", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const agent = fixtureAgent({ finish: ({ root }) => writeFileSync(join(root, "README.md"), "x\n") });
    const h = await run(agent, model);
    expect(h.summary.error).toMatch(/README\.md \(modified outside writes\.modify\)/);
    expect(commits(h.remote)).toBe(1);
  });

  test("finish throws", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const agent = fixtureAgent({
      finish: () => {
        throw new Error("daily note template missing");
      },
    });
    const h = await run(agent, model);
    expect(h.summary.error).toMatch(/daily note template missing/);
  });

  test("a check fails", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const h = await run(fixtureAgent(), model, { checks: [["true"], ["sh", "-c", "echo broken link >&2; exit 1"]] });
    expect(h.summary.status).toBe("failed");
    expect(h.summary.created).toEqual(["notebook/out/ok.md"]);
    expect(h.summary.error).toMatch(/exit 1.*broken link/s);
    expect(commits(h.remote)).toBe(1);
  });

  test("a check writes outside the scope", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const h = await run(fixtureAgent(), model, { checks: [["sh", "-c", "echo x > stray.txt"]] });
    expect(h.summary.error).toMatch(/stray\.txt/);
  });

  test("the model reports an error", async () => {
    const { model } = fakeModel({ "notebook/out/ok.md": "ok\n" }, { ok: false, error: "claude reported is_error" });
    const h = await run(fixtureAgent(), model);
    expect(h.summary).toMatchObject({ status: "failed", cost: 0.25, error: expect.stringMatching(/is_error/) });
    expect(commits(h.remote)).toBe(1);
  });

  test("no meeting-kit.yaml in the repository", async () => {
    const { model, requests } = fakeModel({});
    const { "meeting-kit.yaml": _, ...withoutConfig } = SEED;
    const h = await run(fixtureAgent(), model, { remote: seedRemote(withoutConfig) });
    expect(h.summary.status).toBe("failed");
    expect(h.summary.error).toMatch(/meeting-kit\.yaml is missing/);
    expect(requests).toHaveLength(0);
    expect(h.notified).toHaveLength(1);
  });

  test("an invalid meeting-kit.yaml", async () => {
    const { model, requests } = fakeModel({});
    const h = await run(fixtureAgent(), model, { remote: seedRemote({ ...SEED, "meeting-kit.yaml": "version: 2\n" }) });
    expect(h.summary.error).toMatch(/invalid meeting-kit\.yaml/);
    expect(requests).toHaveLength(0);
  });

  test("an agent the repository's config does not enable", async () => {
    const { model, requests } = fakeModel({});
    const remote = seedRemote({ ...SEED, "meeting-kit.yaml": configYaml({ agents: ["meeting-triage"] }) });
    const h = await run(fixtureAgent(), model, { remote });
    expect(h.summary.error).toMatch(/meeting-synthesis is not enabled in meeting-kit\.yaml \(agents: meeting-triage\)/);
    expect(requests).toHaveLength(0);
  });

  test("an appendix the config names is missing from the repository", async () => {
    const { model, requests } = fakeModel({});
    const remote = seedRemote({ ...SEED, "meeting-kit.yaml": configYaml({ instructions: { [AGENT]: "docs/agents/missing.md" } }) });
    const h = await run(fixtureAgent(), model, { remote });
    expect(h.summary.error).toMatch(/docs\/agents\/missing\.md.*missing from the repository/);
    expect(requests).toHaveLength(0);
  });

  test("an unknown placeholder in the template", async () => {
    const { model, requests } = fakeModel({});
    const code = codeCheckout();
    writeFile(code, "agents/fixture.md", "For {{owner.nickname}}.\n");
    const h = await run(fixtureAgent(), model, { codeRoot: code });
    expect(h.summary.error).toMatch(/unknown placeholder \{\{owner\.nickname\}\}/);
    expect(requests).toHaveLength(0);
  });

  test("an unknown agent", async () => {
    const { model } = fakeModel({});
    const h = await run(fixtureAgent(), model, { agent: "nope" });
    expect(h.summary).toMatchObject({ agent: "nope", status: "failed", error: expect.stringMatching(/unknown agent/) });
    expect(h.notified).toHaveLength(1);
  });
});

describe("the remote moved", () => {
  test("replays the created files and finish on a fresh clone, then pushes", async () => {
    const remote = seedRemote(SEED);
    const { model } = fakeModel({ "notebook/out/mine.md": "mine\n" }, {}, () =>
      pushConcurrent(remote, { [DAILY]: "- notebook/out/theirs.md\n", "notebook/out/theirs.md": "theirs\n" }, true),
    );
    const h = await run(fixtureAgent(), model, { remote });
    expect(h.summary.status).toBe("pushed");
    expect(remoteLog(remote)).toEqual(["meeting-synthesis: create 1 file", "concurrent", "seed"]);
    expect(remoteFile(remote, DAILY)).toBe("# 2026-11-06\n\n## Work\n- notebook/out/theirs.md\n- notebook/out/mine.md\n");
    expect(remoteFile(remote, "notebook/out/theirs.md")).toBe("theirs\n");
    expect(h.logs.some((l) => /push rejected/.test(l))).toBe(true);
  });

  test("a created file that now exists on the remote is a conflict", async () => {
    const remote = seedRemote(SEED);
    const { model } = fakeModel({ "notebook/out/same.md": "mine\n" }, {}, () =>
      pushConcurrent(remote, { "notebook/out/same.md": "theirs\n" }),
    );
    const h = await run(fixtureAgent(), model, { remote });
    expect(h.summary.status).toBe("failed");
    expect(h.summary.error).toMatch(/conflict.*notebook\/out\/same\.md/s);
    expect(remoteFile(remote, "notebook/out/same.md")).toBe("theirs\n");
  });

  test("gives up after three attempts", async () => {
    const remote = seedRemote(SEED);
    const racer = join(tempDir(), "racer.sh");
    // A "check" that lets another writer push before every attempt's push.
    writeFileSync(
      racer,
      `set -e; d=$(mktemp -d); git clone -q ${remote} $d/w; cd $d/w; echo $$ > race-$(date +%s%N).md; git add -A; ` +
        `git -c user.name=r -c user.email=r@x.invalid -c commit.gpgsign=false commit -qm race; git push -q origin HEAD:main`,
    );
    const { model } = fakeModel({ "notebook/out/mine.md": "mine\n" });
    const h = await run(fixtureAgent(), model, { remote, checks: [["sh", racer]] });
    expect(remoteLog(remote).filter((s) => s === "race")).toHaveLength(3);
    expect(h.summary.status).toBe("failed");
    expect(h.summary.error).toMatch(/3 attempts/);
    expect(remoteFile(remote, "notebook/out/mine.md")).toBeNull();
  });
});

describe("dry run and keep", () => {
  test("dry run prints the prompt and args, and calls no model", async () => {
    const { model, requests } = fakeModel({});
    const h = await run(fixtureAgent(), model, { dryRun: true });
    expect(h.summary).toEqual({ agent: AGENT, status: "dry-run", created: [], cost: null, output: null });
    expect(requests).toHaveLength(0);
    const text = h.printed.join("\n");
    expect(text).toContain("Write the notes for 2026-11-06.");
    expect(text).toContain('"--allowedTools"');
    expect(text).toContain('"Read,Write"');
    expect(commits(h.remote)).toBe(1);
  });

  test("dry run with nothing to do", async () => {
    const { model } = fakeModel({});
    const h = await run(fixtureAgent({ prepare: () => null }), model, { dryRun: true });
    expect(h.summary.status).toBe("nothing-to-do");
  });

  test("--keep leaves the clone in place", async () => {
    const { model, requests } = fakeModel({ "notebook/out/ok.md": "ok\n" });
    const h = await run(fixtureAgent(), model, { keep: true });
    expect(h.summary.status).toBe("pushed");
    expect(existsSync(join(requests[0]!.cwd, "notebook/out/ok.md"))).toBe(true);
    expect(h.logs.some((l) => l.includes(requests[0]!.cwd))).toBe(true);
  });
});

describe("default checks", () => {
  test("without a tools directory: the index and the checks from PATH", () => {
    expect(defaultChecks()).toEqual([["nb-index"], ["check-kb"], ["check-tasks"]]);
    expect(defaultChecks("")).toEqual(DEFAULT_CHECKS);
  });

  test("with a tools directory: the same programs from it", () => {
    expect(defaultChecks("/opt/tools/bin")).toEqual([["/opt/tools/bin/nb-index"], ["/opt/tools/bin/check-kb"], ["/opt/tools/bin/check-tasks"]]);
    expect(defaultChecks("/opt/tools/bin/")).toEqual([["/opt/tools/bin/nb-index"], ["/opt/tools/bin/check-kb"], ["/opt/tools/bin/check-tasks"]]);
  });
});
