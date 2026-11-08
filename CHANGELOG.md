# Changelog

## v0.1.0 - 2026-11-08

The first release. It extracts the content-neutral meeting tooling from a private work-memory vault, where it ran
in production, and makes everything specific to that vault configurable.

### Added

- `meeting-kit` command (`nix/package.nix`): `run <agent>`, `render [--check]`, `check-config`, `version`.
- `meeting-kit.yaml` v1 ([docs/config.md](docs/config.md)): owner, organization, time zone, agents, commit identity,
  per-agent instruction appendices, calendar, MCP servers, and Windmill folder, mount, schedules, and webhook.
- Agents: `meeting-synthesis`, `meeting-triage`, `meeting-briefing`, with neutral instruction templates.
  Capture: `src/capture/capture.ts`.
- Windmill templates, rendered into the repository's `windmill/f/<folder>/`:
  - the agent runner script;
  - the synthesis tick;
  - push-triggered synthesis: an HTTP route with HMAC signature auth, a path filter, and the tick as a subflow;
  - the weekday briefings.
- `meeting-kit.just`: `meeting-check`, `meeting-render`, `meeting-run`.
- [Executable kits](docs/executable-kits.md): the pattern, for other kits that ship code.
