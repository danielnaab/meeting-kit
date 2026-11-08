// shared/mcp — a minimal MCP client over streamable HTTP, for the deterministic gates.
//
// No `main`: Windmill treats this as shared logic, and a gate imports it by relative path
// (`../shared/mcp.ts` from a script in a use-case folder, `../../shared/mcp.ts` from a flow's
// inline step). The tests import the same file.
//
// It speaks just enough JSON-RPC for read-only tool calls through an MCP gateway: initialize
// once per client, then `tools/call`. A gate never calls a model; it reads what it needs and
// decides whether an agent run is worth starting.

export interface McpClient {
  /**
   * Call one tool by its gateway name (`<server>__<tool>`, e.g. `Notebook__note_read`) and return
   * its first text content, parsed as JSON. A tool error, or a result with no text, throws.
   */
  tool(name: string, args: Record<string, unknown>): Promise<any>;
}

/** `headers` authenticate every request (the gateway's API key header). */
export function mcpClient(url: string, headers: Record<string, string>, clientName = "meeting-kit-gate"): McpClient {
  let session: string | null = null;
  let nextId = 1;

  async function rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const id = notify ? undefined : nextId++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    session ??= res.headers.get("mcp-session-id");
    if (notify) return null;
    const body = await res.text();
    // A response is plain JSON or an SSE stream whose `data:` lines carry JSON-RPC messages.
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(body)];
    const reply = messages.find((m) => m.id === id);
    if (!reply) throw new Error(`MCP ${method}: no response`);
    if (reply.error) throw new Error(`MCP ${method}: ${reply.error.message}`);
    return reply.result;
  }

  let ready: Promise<void> | null = null;
  const connect = () => (ready ??= (async () => {
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: clientName, version: "1" } });
    await rpc("notifications/initialized", undefined, true);
  })());

  return {
    async tool(name, args) {
      await connect();
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text;
      if (result?.isError || typeof text !== "string") throw new Error(`${name}: ${text ?? "no result"}`);
      return JSON.parse(text);
    },
  };
}
