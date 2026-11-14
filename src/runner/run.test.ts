import { expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.ts";
import { AgentRegistry } from "./registry.ts";
import { main } from "./run.ts";
import { configYaml, remoteFile, seedRemote, tempDir, writeFile } from "./testkit.ts";

const SEED = { "meeting-kit.yaml": configYaml(), "README.md": "x\n" };

const idle: AgentDefinition = {
  name: "meeting-triage",
  instructions: "src/agents/meeting-triage/instructions.md",
  tools: [],
  mcpServers: [],
  writes: { create: [], modify: [] },
  prepare: () => null,
};

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
}

const unusedModel = {
  run: async () => {
    throw new Error("the model must not be called");
  },
};

test("prints a one-line JSON summary and exits 0", async () => {
  const remote = seedRemote(SEED);
  const o = io();
  const code = await main(["meeting-triage", "--remote", remote], {
    env: {},
    registry: new AgentRegistry({ "meeting-triage": async () => idle }),
    model: unusedModel,
    ...o,
  });
  expect(code).toBe(0);
  expect(JSON.parse(o.out.at(-1)!)).toEqual({ agent: "meeting-triage", status: "nothing-to-do", created: [], cost: null, output: null });
  expect(o.out.at(-1)!.includes("\n")).toBe(false);
});

test("a failed run notifies on stderr and exits 1", async () => {
  const remote = seedRemote(SEED);
  const o = io();
  const code = await main(["missing", "--remote", remote], {
    env: {},
    registry: new AgentRegistry({ "meeting-triage": async () => idle }),
    model: unusedModel,
    ...o,
  });
  expect(code).toBe(1);
  expect(JSON.parse(o.out.at(-1)!)).toMatchObject({ agent: "missing", status: "failed", error: expect.any(String) });
  expect(o.err.join("\n")).toMatch(/meeting-kit: missing failed: unknown agent/);
});

test("a usage error exits 2 without a run", async () => {
  const o = io();
  expect(await main([], { env: {}, model: unusedModel, ...o })).toBe(2);
  expect(o.err.join("\n")).toMatch(/usage/);
  expect(o.out).toEqual([]);
});

test("the real registry fails only the agent whose module is missing", async () => {
  const remote = seedRemote(SEED);
  const o = io();
  const code = await main(["no-such-agent", "--remote", remote], { env: {}, model: unusedModel, ...o });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toMatch(/unknown agent "no-such-agent".*meeting-briefing, meeting-synthesis, meeting-triage/);
});

test("MEETING_KIT_TOOLS: the index and checks run from that directory, not from PATH", async () => {
  const remote = seedRemote(SEED);
  const code = tempDir();
  writeFile(code, "agents/writer.md", "# Writer\n");
  const tools = tempDir();
  const log = join(tempDir(), "tools.log");
  for (const name of ["nb-index", "check-kb", "check-tasks"]) {
    writeFile(tools, name, `#!/bin/sh\necho "${name} $*" >> ${log}\n`);
    chmodSync(join(tools, name), 0o755);
  }
  const writer: AgentDefinition = {
    name: "meeting-synthesis",
    instructions: "agents/writer.md",
    tools: ["Write"],
    mcpServers: [],
    writes: { create: ["notebook/out/*.md"], modify: [] },
    prepare: () => ({ prompt: "Write." }),
  };
  const model = {
    run: async (request: { cwd: string }) => {
      writeFile(request.cwd, "notebook/out/a.md", "# A\n");
      return { ok: true, cost: 0.1, turns: 1 };
    },
  };
  const o = io();
  const exit = await main(["meeting-synthesis", "--remote", remote], {
    env: { MEETING_KIT_TOOLS: tools },
    registry: new AgentRegistry({ "meeting-synthesis": async () => writer }),
    codeRoot: code,
    model,
    ...o,
  });
  expect(exit, o.err.join("\n")).toBe(0);
  expect(JSON.parse(o.out.at(-1)!).status).toBe("pushed");
  expect(readFileSync(log, "utf8")).toBe("nb-index \ncheck-kb \ncheck-tasks \n");
  expect(remoteFile(remote, "notebook/out/a.md")).toBe("# A\n");
});

test("MEETING_KIT_REMOTE is the default remote", async () => {
  const remote = seedRemote(SEED);
  const o = io();
  const code = await main(["meeting-triage"], {
    env: { MEETING_KIT_REMOTE: remote },
    registry: new AgentRegistry({ "meeting-triage": async () => idle }),
    model: unusedModel,
    ...o,
  });
  expect(code, o.err.join("\n")).toBe(0);
  expect(o.err.join("\n")).toContain(`cloned ${remote}`);
});
