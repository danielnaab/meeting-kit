# Executable kits

meeting-kit is a graft provider that ships code that runs, not only text that agents read. graft copies a
provider's export into `.scions/<name>/` at a pinned commit, read-only and without executable bits. That is the
right shape for conventions, but code needs more: something has to build and run it, the consuming repository
has to configure it, and anything deployed from it has to stay in step with the pin. This page describes the
pattern meeting-kit uses, so another kit with code can follow it.

## The parts

| Concern | Where it lives | Why |
|---|---|---|
| Code, templates, recipes, docs | The kit, at a semver tag | Content-neutral and reusable; tested in the kit's own repository |
| What the consumer is (names, servers, schedules, deployment) | `<kit>.yaml` at the consumer's top | One versioned file per kit, validated strictly by the kit, so a typo fails loudly |
| Local prose (rules an agent must follow here) | Markdown files the config names | Read at run time from the consumer, appended to the kit's templates |
| The runnable command | `nix/package.nix` in the kit, built from the consumer's pin | Runs from the Nix store copy of the pin, not from the scion, so the exec bit doesn't matter and the consumer's own source (which may hold private content) never enters the store |
| Deployment content (here, Windmill flows) | Rendered by `<kit> render` into the consumer's own tree, and committed | Reviewable: a kit upgrade or a config change shows up as a diff; the deploy side reads plain files from the checkout and needs no knowledge of the kit |
| Operations | `<kit>.just`, imported by the consumer's justfile | One menu (`just`); the consumer wires `<kit>-check` into `check-local` |

## The rules

1. **One pin, two uses.** The scion (for reading) and the package (for running) come from the same flake input, so
   they cannot disagree. Deployed content is rendered from that pin too, and `render --check` in `just check` fails
   when it lags.
2. **The kit never names a consumer.** A test scans the repository for consumer-specific terms. Anything specific
   becomes a config field or a local appendix.
3. **The config has a version.** A change to its shape that breaks consumers bumps `version` and the kit's major
   version, and CHANGELOG.md says how to migrate. Unknown keys are errors.
4. **Rendered trees are kit-owned.** `render` rewrites the whole folder it owns and removes stale files. Consumers
   change the config, never the rendered files. If a consumer needs something the config can't express, that is a
   new config field, added in a minor release.
5. **Run-time reads come from the consumer's clone; build-time inputs come from the pin.** An agent run reads the
   config and the appendices from the vault it cloned, so the content and its rules are always at the same commit.
6. **Tests stay in the kit.** They and their fixtures are `export-ignore`. A consumer checks only its own config and
   the rendered tree, plus whatever smoke test it wants.

## Evolving

- **A second consumer** needs its own `<kit>.yaml` (its own Windmill folder, route, and schedules) and its own
  variables. Nothing in the kit changes.
- **New deployment targets** (another scheduler, a systemd timer) would be another template directory and another
  `render` target, chosen by config.
- **A JSON Schema** for `<kit>.yaml` (editor completion) can be generated from the validator later. The validator
  stays the source of truth.
- **Splitting the kit** is possible later: if one part becomes useful alone (for example, capture), it can become
  its own kit with the same pattern, and consumers would pin both.
