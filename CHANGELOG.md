# Changelog

## v0.2.0 - 2026-11-13

The kit wires itself into a repository that grafts it with graft v2.13.0 or later, where providers are git
submodules. 0.y counts as a major for graft, so `graft upgrade` takes it only when named
(`meeting-kit@v0.2.0`). The command, its config and the rendered Windmill tree are unchanged.

### Added

- **`graft.nix`:** graft's mkFlake adds the `meeting-kit` command to the repository's graft tools
  (`packages.<system>.tools`). It runs from graft's store copy of the kit alone, as before, on bun 1.3.3 that the
  kit pins itself (nixos-25.11 at the revision of its own `flake.lock`, a fixed-output fetch). The kit's own
  flake builds its package from `graft.nix`, so the command is defined once.

### Changed

- README, `docs/executable-kits.md` and `meeting-kit.just` describe the submodule shape:
  `import? "scions/meeting-kit/meeting-kit.just"`, the whole repository grafted, `.gitattributes` read only by
  `git archive`. `nix/package.nix` is unchanged and still takes `{ pkgs, bun ? pkgs.bun }`.

### Upgrading

In a repository on graft v2.13.0 or later that grafted meeting-kit v0.1.x in copy mode (follow graft's own
v2.13.0 Upgrading steps first; they remove the `meeting-kit` flake input):

1. Graft the kit: `nix run .#graft add https://github.com/danielnaab/meeting-kit@v0.2.0` (for a flake in a
   subdirectory, add `--scions` with its scions directory, e.g. `--scions nix/agent-tools/.scions`). Commit.
2. In `flake.nix`, delete the `import "${inputs.meeting-kit}/nix/package.nix" { … }` wiring (for example in
   notebook-kit's `extraPackages`). `meeting-kit` is now in `packages.<system>.tools` from graft.
3. Delete the repository's own bun input (such as `nixpkgs-bun`) if it was there only for meeting-kit; keep it if
   the repository uses bun itself (graft's `perSystem` can add it to the tools).
4. In the justfile, change `import ".scions/meeting-kit/meeting-kit.just"` to
   `import? "<scions directory>/meeting-kit/meeting-kit.just"`. Other paths that named the old scion
   (`bun .scions/meeting-kit/…` in docs or instruction appendices) move the same way.
5. Check: `nix build .#tools && ./result/bin/meeting-kit version` prints `v0.2.0`; `just meeting-check` passes
   (the rendered `windmill/` tree does not change, as no template changed).

## v0.1.3 - 2026-11-11

### Changed

- notebook-conventions is now notebook-kit: README, and the usage comments in `flake.nix` and `nix/package.nix`,
  use the new name (`${inputs.notebook-kit}/nix/workspace.nix`). Nothing else changes; a workspace takes this
  release with notebook-kit v1.0.0.

## v0.1.2 - 2026-11-08

### Changed

- Copyright notice: Copyright 2026 Daniel Naab (`LICENSE`, `NOTICE`, README).

## v0.1.1 - 2026-11-08

### Changed

- An instruction appendix may be a regular document in its repository. Its YAML frontmatter, its `#` title, and a
  trailing `## Sources` section stay out of the prompt, so the appendix can carry lifecycle status and provenance.

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
