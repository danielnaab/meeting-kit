// workday_start's first step: today's meetings on the owner's work calendar, for the triage. It runs on the default
// workers and never calls a model. The rule, and what it drops before the triage sees it, is in
// ../meeting_briefing/calendar.ts; its answer is the day meeting-triage takes as its input.
//
// A calendar it can't read throws. The step is continue_on_error, so the closing check fails the flow for it.
import { day, todayIn } from "../meeting_briefing/calendar.ts";
import { mcpClient } from "../shared/mcp.ts";
import { variable } from "../shared/windmill.ts";

export async function main(calendar: string, calendar_mcp_url: string) {
  // The calendar server's key: the same Windmill variable and header the agents' MCP config uses.
  const key = await variable("f/meeting_kit/{{api_key_variable}}");
  const client = mcpClient(calendar_mcp_url, { "{{api_key_header}}": key }, "meeting-kit-calendar-gate");
  const result = await day(client, todayIn("{{timezone}}"), calendar);
  for (const d of result.dropped) console.log(`dropped ${d.start} ${d.summary}: ${d.reason}`);
  return result;
}
