import type { AgentDefinition } from "../../agents/types.ts";

const agent: AgentDefinition = {
  name: "fixture-agent",
  instructions: "instructions.md",
  tools: ["Read", "Write"],
  mcpServers: [],
  writes: { create: ["notebook/out/*.md"], modify: [] },
  prepare: () => ({ prompt: "fixture" }),
};

export default agent;
