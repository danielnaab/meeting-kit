/** Test helpers: a stand-in for the calendar MCP server, answering Calendar__events. Synthetic events only. */
import type { CalendarEvent } from "../../windmill/f/meeting_kit/meeting_briefing/calendar.ts";

export const WORK_CALENDAR = "work/sam@example.com";

export const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  calendar: WORK_CALENDAR,
  uid: "u1@example.org",
  start: "2026-11-09T10:00:00-07:00",
  end: "2026-11-09T10:30:00-07:00",
  all_day: false,
  summary: "Sprint review",
  attendee_count: 5,
  ...over,
});

export interface CalendarCall {
  name: string;
  args: any;
  key: string | null;
}

/** A calendar server on a free port. `answer` gets the tool's arguments and returns its JSON answer. */
export function calendarServer(answer: (args: any) => unknown, keyHeader = "x-api-key") {
  const calls: CalendarCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const msg = await req.json();
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {} });
      const { name, arguments: args } = msg.params;
      calls.push({ name, args, key: req.headers.get(keyHeader) });
      if (name !== "Calendar__events") return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
      return reply({ content: [{ type: "text", text: JSON.stringify(answer(args)) }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => server.stop(true) };
}
