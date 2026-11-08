/**
 * The read-only MCP tools the meeting agents may use, by server key in the runner's MCP config. Names follow
 * Claude Code's mcp__<server key>__<tool> form; the MCP gateway the kit was built against prefixes each tool with its server name.
 */
const tools = (server: string, prefix: string, names: string[]) => names.map((t) => `mcp__${server}__${prefix}__${t}`);

export const CALENDAR_READS = tools("calendar", "Calendar", ["list_calendars", "events", "search", "get_event", "free_busy"]);
export const CONTACTS_READS = tools("contacts", "Contacts", ["search_contacts", "get_contact"]);
export const RECORDS_READS = tools("records", "Records", ["search_records", "read_record", "related_records"]);
