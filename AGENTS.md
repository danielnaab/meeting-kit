# meeting-kit: agent entrypoint

The kit is public and content-neutral. Never add names of people or organizations, calendars, hostnames, or anything
else specific to one vault. Those belong in a consumer's `meeting-kit.yaml` or its instruction appendices.
`src/neutrality.test.ts` enforces this.

- Read [README.md](README.md) and [docs/executable-kits.md](docs/executable-kits.md) first.
- Work test first. `bun test` and `bun run typecheck` must pass, and `nix flake check` runs the tests.
- `windmill/f/meeting_kit/` holds templates: keep them valid TS, YAML, and shell, with placeholders inside strings.
  Test the rendered output (`windmill/tests/`), not the templates.
- Releases: add a `CHANGELOG.md` section, then a semver tag. A config format change bumps `version` in
  `src/config/config.ts` and the major version, with an **Upgrading** subsection.
