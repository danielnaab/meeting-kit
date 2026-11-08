/**
 * The agents the runner can run, by name. Each entry is a loader, so an agent's module is imported only when that
 * agent is run: a missing or broken module fails its own runs and nobody else's.
 */
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.ts";

export type AgentLoader = () => Promise<AgentDefinition>;

/** The meeting agents in src/agents/<name>/agent.ts. */
export const AGENT_NAMES = ["meeting-synthesis", "meeting-triage", "meeting-briefing"];

export class AgentRegistry {
  constructor(private readonly loaders: Record<string, AgentLoader>) {}

  names(): string[] {
    return Object.keys(this.loaders).sort();
  }

  async get(name: string): Promise<AgentDefinition> {
    const load = Object.hasOwn(this.loaders, name) ? this.loaders[name] : undefined;
    if (!load) throw new Error(`unknown agent "${name}"; known agents: ${this.names().join(", ")}`);
    const agent = await load();
    if (agent.name !== name) throw new Error(`agent module for "${name}" names itself "${agent.name}"`);
    return agent;
  }
}

/** Loaders that import the default export of each named module. */
export function moduleLoaders(names: string[], pathOf: (name: string) => string): Record<string, AgentLoader> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      async () => {
        const mod = await import(pathOf(name));
        const agent = mod.default as AgentDefinition | undefined;
        if (!agent || typeof agent !== "object" || typeof agent.prepare !== "function") {
          throw new Error(`agent module for "${name}" has no default AgentDefinition export`);
        }
        return agent;
      },
    ]),
  );
}

/** The real registry: src/agents/<name>/agent.ts for each known agent. */
export function defaultRegistry(): AgentRegistry {
  const agentsDir = join(import.meta.dir, "..", "agents");
  return new AgentRegistry(moduleLoaders(AGENT_NAMES, (name) => join(agentsDir, name, "agent.ts")));
}
