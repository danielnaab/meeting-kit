# The `meeting-kit` command

A repository that grafts the kit has `meeting-kit` in its graft tools. Output is for people by default. `--json`,
where a command has it, prints one JSON object whose `schema` field names its shape and version. Errors go to
stderr, say what failed, and give the command that fixes it or tries again.

| Command | What it does |
|---|---|
| `meeting-kit run <agent> [options]` | Run one meeting agent on a fresh clone of the repository (below) |
| `meeting-kit meetings [--json] [--date YYYY-MM-DD] [--root DIR]` | List the day's meetings, by the ID `run meeting-briefing --meeting` takes |
| `meeting-kit render [--root DIR] [--check]` | Write (or check) the repository's `windmill/` tree from `meeting-kit.yaml` |
| `meeting-kit check-config [--root DIR]` | Validate `meeting-kit.yaml` |
| `meeting-kit version` | The kit's version |

## `meeting-kit meetings`

Reads one day (`--date`, default today in `meeting-kit.yaml` `timezone`) of the calendar `calendar.id` through
the calendar MCP server `mcp.servers.calendar`, with the key from the environment variable `mcp.apiKey.env`. It
applies the rule the workday_start flow's calendar gate applies. All-day, cancelled, declined or free events, and
events with no other attendees, are not meetings to prepare for: they are listed under `dropped`, with the reason,
and `--meeting` does not accept them. `--root` is the repository whose `meeting-kit.yaml` is read (default `.`).

A meeting's ID is `<date>/<uid>`: the day it was listed for, and its calendar uid. A recurring series shares one
uid, so the date picks the occurrence. The ID stays the same for that day when the title or time changes.

```sh
$ meeting-kit meetings --date 2026-11-09
2026-11-09/7kq2@example.org  10:00-10:30  Sprint review
not listed: Focus time (13:00): no other attendees
```

### `--json`: `meetings/1`

```json
{
  "schema": "meetings/1",
  "date": "2026-11-09",
  "calendar": "work/alex@example.com",
  "meetings": [
    {
      "id": "2026-11-09/7kq2@example.org",
      "title": "Sprint review",
      "start": "2026-11-09T10:00:00-05:00",
      "end": "2026-11-09T10:30:00-05:00",
      "calendar": "work/alex@example.com",
      "uid": "7kq2@example.org",
      "location": "Room 4",
      "organizer": "lead@example.com",
      "attendee_count": 5,
      "recurring": true,
      "status": "confirmed"
    }
  ],
  "dropped": [{ "title": "Focus time", "start": "2026-11-09T13:00:00-05:00", "reason": "no other attendees" }],
  "stale_calendars": [],
  "omitted": 0
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"meetings/1"` | This shape. A change that would break a reader is `meetings/2`; a new optional field is not. |
| `date` | `YYYY-MM-DD` | The day listed |
| `calendar` | string | `meeting-kit.yaml` `calendar.id` |
| `meetings[]` | object | The meetings `--meeting` accepts, in the calendar server's order |
| `meetings[].id` | string | `<date>/<uid>`: pass it to `run meeting-briefing --meeting` |
| `meetings[].title`, `start`, `end`, `calendar`, `uid` | string | Always present. `start` and `end` are ISO 8601 with offset. |
| `meetings[].location`, `organizer`, `status` | string | Present when the calendar has them |
| `meetings[].attendee_count` | number | Present when the calendar has it |
| `meetings[].recurring` | boolean | Present when the calendar has it |
| `dropped[]` | `{title, start, reason}` | Events that are not meetings to prepare for, and why |
| `stale_calendars` | array | As the calendar server reports them: calendars not synced lately, whose events may be missing |
| `omitted` | number | Events past the calendar server's per-call cap, which nobody saw |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Listed (an empty day too) |
| 1 | The calendar could not be read. stderr has the server's answer and the command to try again. |
| 2 | The command can't start as given: an argument, `meeting-kit.yaml`, or the key's environment variable |

## `meeting-kit run`

```text
meeting-kit run <agent> [--meeting ID [--why TEXT] | --input JSON] [--dry-run] [--keep] [--remote URL]
                        [--mcp-config PATH] [--today YYYY-MM-DD]
```

The repository is `--remote`, or `MEETING_KIT_REMOTE`. Logs go to stderr. The last stdout line is a JSON
summary, `{agent, status, created, cost, output}`, plus `notices` and, for a failed run, `error`. `--dry-run`
prints the prompt and the claude arguments, and calls no model.

Each agent takes only its own arguments:

| Agent | Takes |
|---|---|
| `meeting-synthesis` | Neither: it finds the pending transcripts itself |
| `meeting-triage` | `--input JSON`, optional: the calendar gate's day (the workday_start flow passes it) |
| `meeting-briefing` | `--meeting ID`, required: an ID from `meeting-kit meetings`. `--why TEXT`, optional: one line on why it gets a briefing. |

For `--meeting` the runner reads the meeting from the calendar when the run starts, through the server and key
that `meetings` uses. An ID the calendar doesn't list for that day fails the run, and the error gives
`meeting-kit meetings --date <date>`.

| Code | Meaning |
|---|---|
| 0 | The run finished: `pushed`, `no-changes`, `nothing-to-do` or `dry-run` |
| 1 | The run failed (`status: "failed"`); the summary's `error` says why |
| 2 | Usage: a bad argument, or one the agent does not take. Nothing is cloned and no summary is printed. |
