# meeting-kit.yaml

A repository that uses meeting-kit describes itself in `meeting-kit.yaml` at its top. The kit holds nothing about
any repository: no names, calendars, servers, or schedules. [examples/meeting-kit.yaml](../examples/meeting-kit.yaml)
is a complete example. `meeting-kit check-config` (part of `just meeting-check`) validates the file and lists every
problem. Unknown keys are errors.

Two parts of the kit read the file:

- **The runner, at run time,** reads it from its fresh clone of the vault: `owner`, `organization`, `timezone`,
  `calendar`, `agents`, `identity`, `instructions`. A change merged to the vault reaches the next run.
- **`meeting-kit render`** reads it when you render: `timezone`, `calendar`, `mcp`, `windmill`. A change needs
  `just meeting-render` and a commit, then the host's Windmill sync.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | The config format, `1`. A kit major release that changes the format says how to migrate. |
| `owner.name`, `owner.short` | yes | The person whose work the vault holds: the full name, and how the instructions address them. |
| `organization` | yes | Whose work this is. The agents keep the vault to it. |
| `timezone` | yes | An IANA zone. It sets the agents' "today" and the schedules' zone. |
| `agents` | no | The agents this repository runs. Default: `meeting-synthesis`, `meeting-triage`, `meeting-briefing`. A run of any other agent fails. |
| `identity.name`, `identity.email` | yes | The author of the agents' commits. |
| `instructions.<agent>` | no | A Markdown file in the repository, appended to that agent's instructions under "Local rules". Use it for rules and facts specific to this vault: people's aliases, which sources to trust, boundaries. |
| `calendar.id` | yes | The calendar the triage and briefings read, as the calendar MCP server names it. |
| `mcp.servers.<key>.url` | yes | The MCP servers agents may be given, by the key an agent asks for (`calendar`, `contacts`, `records`). An agent is given only the servers it lists that are configured here. |
| `mcp.apiKey.header`, `.env`, `.variable` | yes | Every server gets the header `<header>: ${<env>}`. The agent runner sets `<env>` from the Windmill variable `f/<folder>/<variable>`. The rendered MCP config holds only the reference, never the key. |
| `windmill.folder` | yes | The Windmill folder: `render` writes `windmill/f/<folder>/`, and the variables live under `f/<folder>/`. |
| `windmill.mount` | yes | Where the agent worker mounts the repository's checkout, read-only. |
| `windmill.claudeConfigDir` | yes | claude's config directory under the worker's persistent home. |
| `windmill.schedules.synthesis`, `.workdayStart` | yes | Six-field Windmill cron expressions in `timezone`: the synthesis tick and the weekday briefings. |
| `windmill.webhook.route` | no | Turns on push-triggered synthesis: a Windmill HTTP route (`/api/r/<route>`) for the Git host's push webhook. |
| `windmill.webhook.signatureHeader` | no | The header that carries the webhook's HMAC-SHA256 (hex). Default: `X-Forgejo-Signature`. |

## Instruction templates

Each agent's `instructions.md` in the kit is a template. These placeholders are filled from the config:

- `{{owner.name}}`, `{{owner.short}}`
- `{{organization}}`
- `{{timezone}}`
- `{{calendar.id}}`

An unknown placeholder fails the run, so a template and its config can't silently disagree. The repository's
appendix is appended after the template, verbatim.
