import { expect, test } from "bun:test";
import type { AgentDefinition } from "../agents/types.ts";
import { AgentRegistry, moduleLoaders } from "./registry.ts";

const fake = (name: string): AgentDefinition => ({
  name,
  instructions: "src/agents/fake/instructions.md",
  tools: ["Read"],
  mcpServers: [],
  writes: { create: [], modify: [] },
  prepare: () => null,
});

test("resolves an agent by name from its loader", async () => {
  const registry = new AgentRegistry({ alpha: async () => fake("alpha") });
  expect((await registry.get("alpha")).name).toBe("alpha");
  expect(registry.names()).toEqual(["alpha"]);
});

test("an unknown name fails and lists the known agents", async () => {
  const registry = new AgentRegistry({ alpha: async () => fake("alpha"), beta: async () => fake("beta") });
  await expect(registry.get("gamma")).rejects.toThrow(/unknown agent "gamma".*alpha, beta/);
});

test("a loader whose agent has another name is rejected", async () => {
  const registry = new AgentRegistry({ alpha: async () => fake("beta") });
  await expect(registry.get("alpha")).rejects.toThrow(/names itself "beta"/);
});

test("only the loader of the agent that is run is called", async () => {
  const registry = new AgentRegistry({
    alpha: async () => fake("alpha"),
    broken: async () => {
      throw new Error("module missing");
    },
  });
  expect((await registry.get("alpha")).name).toBe("alpha");
  await expect(registry.get("broken")).rejects.toThrow(/module missing/);
});

test("module loaders import the default export of each agent module", async () => {
  const loaders = moduleLoaders(["fixture-agent"], (name) => `${import.meta.dir}/testdata/${name}.ts`);
  const agent = await new AgentRegistry(loaders).get("fixture-agent");
  expect(agent.tools).toEqual(["Read", "Write"]);
});

test("a module without a default AgentDefinition is reported", async () => {
  const loaders = moduleLoaders(["no-default"], (name) => `${import.meta.dir}/testdata/${name}.ts`);
  await expect(new AgentRegistry(loaders).get("no-default")).rejects.toThrow(/no default AgentDefinition/);
});
