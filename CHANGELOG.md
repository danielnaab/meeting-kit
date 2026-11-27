# Changelog

## v0.6.0 - 2026-11-27

A breaking version: the provider file is `pattern.nix`, tuteur's name for it from v0.2.1, in place of graft's
`graft.nix`. What the kit gives a repository is unchanged.

### Changed

- **`graft.nix` is now `pattern.nix`** ([provider/3](https://github.com/danielnaab/tuteur/blob/v0.2.1/docs/reference/provider.md)):
  the same `meeting-kit` tool, with the kit's pinned bun. The kit's own flake and the README name it.

### Upgrading

1. Take tuteur v0.2.1 or later first (a patch: `nix run .#tuteur upgrade`, or the weekly job): tuteur v0.2.0 and
   graft read only `tuteur.nix` or `graft.nix`, so with this version their repository's tools lose `meeting-kit`.
2. Take this version by name: `nix run .#tuteur upgrade meeting-kit@v0.6.0`.
3. Done when `nix run .#tuteur check` passes and `meeting-kit --help` runs from the repository's tools.

## v0.5.0 - 2026-11-24

People notes are named by the person's name, as notebook-kit v2.3.0 names wiki pages: `wiki/people/Ada Lovelace.md`,
with no `title` or heading repeating it, so Obsidian's `[[` autocomplete and link text show the name. Vaults whose
people notes are still slug-named with a `title` keep working.

### Changed

- **People resolve by filename too.** A person note's name is its `title` when it has one, else its filename, so a
  note without `title` is found (before, it was skipped).
- **New people notes are named by the name** (`createPerson`, `people.ts create`): `wiki/people/Robin Hart.md`
  with `aliases: ["@Robin Hart"]` and no `title` or `# heading`. A name a filename can't hold
  (`: / \ ? * " < > | # ^ [ ]`) gets the nearest filename, `Jo / Joanne Park` -> `Jo - Joanne Park.md`, and keeps
  `title`.
- **Links to people are percent-encoded** (`../../../wiki/people/Ada%20Lovelace.md`): the resolutions
  meeting-briefing and meeting-synthesis put in their prompts. Before, a space was written as is, which breaks a
  Markdown link.
- **Agent instructions** (meeting-synthesis, meeting-briefing, meeting-triage): person notes are named by the
  person's name; link to the file name found, spaces as `%20`, never a slug guessed from the name; new person
  notes (synthesis) have no `title` or heading.
- `src/vault/names.ts`: `fileName` (mirrors notebook-kit's `names.py`) and `linkPath`.

### Upgrading

1. `just upgrade meeting-kit@v0.5.0`, then `just meeting-render` and commit the rendered `windmill/` with it.
   `meeting-kit.yaml` is unchanged (`version: 1`).
2. Optional: rename existing people notes with notebook-kit v2.3.0's `just names --fix notebook/wiki/people`
   (or the whole `wiki/`). Before that, the agents keep resolving the slug-named notes by `title`.
3. Local instructions (`instructions.<agent>`) that give people's paths as slugs: give the file names instead.
4. Done when `just meeting-check` and `just check` pass.

## v0.4.0 - 2026-11-21

The command gains typed arguments a caller can validate: `meeting-briefing` takes a meeting by ID instead of free
JSON, and `meeting-kit meetings` lists the IDs. It breaks callers of `run meeting-briefing --input` and changes the
rendered `windmill/` tree. `meeting-kit.yaml` is unchanged (still `version: 1`).

### Added

- **`meeting-kit meetings [--json] [--date YYYY-MM-DD] [--root DIR]`** lists one day of the configured calendar
  (default today, in `timezone`): the meetings `run meeting-briefing --meeting` accepts, each with its ID
  `<date>/<uid>`, and the events left out, with the reason. It reads the calendar through
  `mcp.servers.calendar` with the key in the environment variable `mcp.apiKey.env`, applying the workday_start
  calendar gate's rule (the same file). Human lines by default; `--json` prints the versioned `meetings/1` shape.
  Exit codes: 0 listed, 1 calendar unreadable, 2 bad arguments, config or environment.
  [docs/cli.md](docs/cli.md) documents the command, the shape and the exit codes.
- **`meeting-kit run meeting-briefing --meeting ID [--why TEXT]`**. The runner reads the meeting from the
  calendar when the run starts. An ID that the calendar doesn't list fails the run, and the error gives the
  command that lists the IDs. `--why` carries the triage's one line, as the flow's `why` did.
- **`AgentDefinition.takes`** (`"meeting"`, `"input"`, or absent) says which arguments an agent accepts. An
  argument the agent does not take, or a missing `--meeting`, is a usage error (exit 2) before anything is
  cloned.

### Changed

- **`--input` is meeting-triage's alone.** Its caller is the workday_start flow, which passes the calendar gate's
  day. meeting-briefing rejects `--input`, and meeting-synthesis takes neither argument.
- **meeting-briefing resolves only the organizer.** Before, it also resolved the `attendees` an `--input` could
  carry. The calendar listing has the organizer and an attendee count, and the model still reads the attendees
  from `get_event`.
- **The runner script's agent dropdown is rendered from the runner's registry** (`src/runner/registry.ts`
  `AGENT_NAMES`), not written out in `agent/run.script.yaml`.
- **`agent/run.sh` takes five arguments: `agent`, `meeting`, `why`, `input`, `dry_run`.** Before, it took
  `agent`, `input` and `dry_run`. The workday_start briefing loop passes `meeting` (the gate's date and the
  triage's uid) and `why` instead of `input`. The flow, the script's schema, `run.sh` and the rendered `README.md`
  change. `dry_run` is still a string.

### Upgrading

1. Upgrade the kit, `just meeting-render`, and commit `windmill/`. Deploy it and the checkout's tools together:
   the new flow passes `--meeting`, which an older runner rejects, and an older flow passes `--input` to the
   briefing, which this runner rejects.
2. Change anything outside the flows that ran `meeting-kit run meeting-briefing --input '{…}'` (scripts, notes,
   a manual Windmill run of `agent/run` with `input`):
   - find the meeting's ID with `meeting-kit meetings --date YYYY-MM-DD` (from the repository's checkout, with
     the `mcp.apiKey.env` variable set);
   - run `meeting-kit run meeting-briefing --meeting <date>/<uid>`, adding `--why "…"` if you had a `why`.
   A meeting the calendar does not list (all-day, cancelled, declined, solo) can no longer be briefed by passing
   its JSON.
3. Nothing changes for `meeting-kit run meeting-triage --input` or for meeting-synthesis.
4. A positional call of `f/<folder>/agent/run` (rather than by name, as the flows call it) must use the new
   order: `agent, meeting, why, input, dry_run`.

## v0.3.1 - 2026-11-16

### Fixed

- **The model fallback missed the org spend limit.** A Team or Enterprise account stops with "You've hit your org's
  monthly spend limit · ask your admin to raise it", which the usage-limit check (one word between "hit your" and
  "limit") did not match, so the run failed instead of moving to the fallback. Up to 40 characters of words,
  apostrophes (straight or curly) and hyphens may now come between them. No config or rendered-tree change.

## v0.3.0 - 2026-11-16

### Added

- **Model fallback** (`windmill.modelFallback` in `meeting-kit.yaml`, optional). When `claude` stops on the account's
  usage limit (a subscription's session, weekly or monthly limit, or a rate limit), the runner resets its clone and
  reruns the model once through an Anthropic-compatible gateway: `baseUrl` (`ANTHROPIC_BASE_URL`), the key from the
  Windmill variable `variable` as the bearer token, and optionally also in `header`. The subscription's token is
  removed from that run. The job's result gains `fallback: "usage-limit"` and the label `model:fallback`. Without
  the config, or with the variable missing (a warning), a usage limit fails the run as before.
- The runner reads the fallback from `MEETING_KIT_FALLBACK_BASE_URL`, `MEETING_KIT_FALLBACK_TOKEN` and
  `MEETING_KIT_FALLBACK_HEADER`, so `meeting-kit run` outside Windmill can use it too. The model's own `claude`
  never sees them.

### Changed

- `run.sh` also unsets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` before the run,
  so a stray one can't redirect the subscription's run. The rendered `windmill/` tree changes (`run.sh`,
  `README.md`) whether or not the fallback is configured.
- claude's stderr is read (and still passed through to the job log), to recognize a usage limit reported there.

### Upgrading

No config change is needed. `graft upgrade meeting-kit@v0.3.0`, then `meeting-kit render` and commit `windmill/`.
To turn the fallback on, add `windmill.modelFallback`, render, and create its Windmill variable.

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
