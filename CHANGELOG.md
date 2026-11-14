# Changelog

## v0.2.0 - 2026-11-13

The kit wires itself into a repository that grafts it with graft v2.13.0 or later, where providers are git
submodules. 0.y counts as a major for graft, so `graft upgrade` takes it only when named
(`meeting-kit@v0.2.0`). It needs notebook-kit v2.0.0 or later in the same repository (the index tool's new name).

### Added

- **`graft.nix`:** graft's mkFlake adds the `meeting-kit` command to the repository's graft tools
  (`packages.<system>.tools`). It runs from graft's store copy of the kit alone, as before, on bun 1.3.3 that the
  kit pins itself (nixos-25.11 at the revision of its own `flake.lock`, a fixed-output fetch). The kit's own
  flake builds its package from `graft.nix`, so the command is defined once.

### Changed

- **The runner fills the repository's scions.** After its shallow clone it runs
  `git submodule update --init --recursive` (at depth 1 where the server allows it), so an agent reads the kits
  in the clone (`bun <scions>/meeting-kit/…`) and `check-kb` resolves links into them. The host's git needs read
  access to every scion's URL.
- **The runner and `run.sh` call `nb-index`** (was `index`), notebook-kit v2.0.0's name. The rendered
  `windmill/` tree changes (`run.sh`, `README.md`).
- **Docs:** call `meeting-check` from `check-local`'s body, never as its dependency: with the scion empty,
  `import?` skips the kit's recipes and `just` then rejects the whole justfile.
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
   (`bun .scions/meeting-kit/…` in docs or instruction appendices) move the same way. If `check-local` lists
   `meeting-check` as a dependency (`check-local: meeting-check`), call it from the body instead:
   `check-local:` then, indented, `@{{just_executable()}} --justfile {{quote(justfile())}} meeting-check`.
5. Take notebook-kit v2.0.0 in the same change (its own Upgrading steps); drop any `index` → `nb-index` shim.
6. `just meeting-render`, then commit `windmill/` (`run.sh` now checks for `nb-index`).
7. Check: `nix build .#tools && ./result/bin/meeting-kit version` prints `v0.2.0`; `just meeting-check` passes.

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
