# meeting-kit

Meeting agents for a Markdown work-memory vault, and the Windmill flows that run them. A repository grafts the kit
in, describes itself in `meeting-kit.yaml`, and keeps only its content and configuration.

- **meeting-synthesis** turns a captured transcript into a synthesis note. It also updates the people notes it
  mentions and the day's daily note.
- **meeting-triage** reads the day's calendar and chooses the meetings worth a briefing.
- **meeting-briefing** writes a briefing for one meeting from the calendar, contacts, and the vault.
- **capture** files a freshly transcribed meeting under `notebook/raw/meetings/`, where synthesis finds it.

Every agent runs headless (`claude -p --restricted`) in a fresh clone of the vault. The model may only create files
inside the agent's write scope. Everything deterministic is code: the daily-note lines, the indexes, the checks, the
commit, and the push. Nothing reaches the remote unless every change is in scope and every check passed.

The vault follows the [notebook-kit](https://github.com/danielnaab/notebook-kit) layout, and the
runner calls its `nb-index`, `check-kb`, and `check-tasks` tools (notebook-kit v2.0.0 or later). The flows expect a self-hosted
[Windmill](https://www.windmill.dev/) whose agent worker mounts a checkout of the vault, as described in the
rendered `windmill/README.md`.

## Use it

The kit is a [graft](https://github.com/danielnaab/graft) provider. In the repository that uses it:

1. **Graft it** (graft v2.13.0 or later). The kit's `graft.nix` adds the `meeting-kit` command to the repository's
   graft tools (`packages.<system>.tools`), with the bun it is tested with; the repository's flake names nothing
   of the kit:

   ```sh
   nix run .#graft add https://github.com/danielnaab/meeting-kit@v0.2.0
   ```

   This adds the git submodule `scions/meeting-kit/` (in the repository's scions directory, if it has one: for a
   flake in a subdirectory, `--scions nix/agent-tools/.scions`). Commit it.

2. **Describe the repository.** Copy [examples/meeting-kit.yaml](examples/meeting-kit.yaml) to the repository's
   top and fill it in. [docs/config.md](docs/config.md) explains each field. Local rules for an agent go in a
   Markdown file that the config names under `instructions`.

3. **Wire the recipes.** In the justfile:

   ```just
   import? "scions/meeting-kit/meeting-kit.just"
   meeting_kit := tools + "/meeting-kit"
   # plus the workspace's own checks; meeting-check is called, not listed as a dependency (see below)
   check-local:
       @{{just_executable()}} --justfile {{quote(justfile())}} meeting-check
   ```

   `import?` keeps `just` working in a clone whose scions are not filled yet only while no recipe of the
   workspace *depends on* an imported one: `check-local: meeting-check` makes the whole justfile fail to parse
   there ("unknown dependency"). Call imported recipes from the recipe's body, as above.

4. **Render the Windmill tree** with `just meeting-render`, then commit `windmill/`. `just check` now fails if
   `windmill/` drifts from the config or from the pinned kit.

5. **Deploy.** The host's Windmill sync pushes `windmill/f/<folder>/`. It needs the variables listed in the
   rendered `windmill/README.md`, under `f/<folder>/`.

To upgrade, run `just upgrade` (graft moves the submodule to the new tag), read `just changelog`, run
`just meeting-render`, and commit. The diff of `windmill/` is the deployment change you are taking.

## Layout

| Path | What it is |
|---|---|
| `src/cli.ts` | The `meeting-kit` command: `run`, `render`, `check-config`, `version` |
| `src/config/` | `meeting-kit.yaml`: the contract between the kit and a repository |
| `src/runner/` | One agent run: clone, prepare, model, scope checks, finish, index and checks, commit, push |
| `src/agents/<name>/` | Each agent: its code (`agent.ts`) and instruction template (`instructions.md`) |
| `src/vault/`, `src/people/`, `src/capture/` | The vault's meeting layout, people notes, and capture |
| `src/windmill/render.ts` | Renders `windmill/f/meeting_kit/` (templates) into a repository's `windmill/f/<folder>/` |
| `windmill/f/meeting_kit/` | Windmill templates: the agent runner script, the synthesis tick, the push-triggered synthesis, and the workday briefings |
| `graft.nix` | What a repository that grafts the kit gets: the `meeting-kit` tool, with the kit's pinned bun |
| `nix/package.nix` | The command, built from the kit's own commit |
| `meeting-kit.just` | Recipes a repository imports |
| `docs/` | [config](docs/config.md), [executable kits](docs/executable-kits.md) (the pattern this kit follows) |

## Develop

`nix develop` (or any bun ≥ 1.2.21), `bun install`, then `bun test` and `bun run typecheck`. `nix flake check` runs
the tests. To try an unreleased change in a repository that grafts the kit, see graft's "Fix a provider from a
consumer" guide.
Release with a semver tag and a `CHANGELOG.md` section. A change that breaks consumers gets a new major version and an
**Upgrading** subsection.

## License

Copyright 2026 Daniel Naab. Licensed under [Apache-2.0](LICENSE).
