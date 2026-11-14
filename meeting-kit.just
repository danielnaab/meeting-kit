# meeting-kit operations, read in place from the scion. A workspace's justfile imports it (`import?`, so a clone
# whose submodules are not filled in yet still lists its own recipes; the path is the scion's, under graft's scions
# directory):
#
#   set allow-duplicate-variables
#   import? "scions/meeting-kit/meeting-kit.just"
#   meeting_kit := tools + "/meeting-kit"      # how the command runs here (default: meeting-kit on PATH)
#
# and runs `meeting-check` from its check-local's body, so `just check` covers the config and the rendered tree:
#
#   check-local:
#       @{{just_executable()}} --justfile {{quote(justfile())}} meeting-check
#
# Never list an imported recipe as a dependency (`check-local: meeting-check`): with the scion empty, `import?`
# skips this file and `just` then refuses the whole justfile ("unknown dependency").

# The meeting-kit command: a workspace points it at its graft tools package (graft.nix); MEETING_KIT per shell.
meeting_kit := env("MEETING_KIT", "meeting-kit")

# Validate meeting-kit.yaml and check that windmill/ is rendered from it and from this kit version
[group('meetings')]
meeting-check:
    "{{meeting_kit}}" check-config --root {{quote(justfile_directory())}}
    "{{meeting_kit}}" render --root {{quote(justfile_directory())}} --check

# Render windmill/ from meeting-kit.yaml and the kit's templates (after editing the config or upgrading the kit)
[group('meetings')]
meeting-render:
    "{{meeting_kit}}" render --root {{quote(justfile_directory())}}

# Run a meeting agent locally: just meeting-run AGENT [--dry-run] [--input JSON] [--remote URL] ...
[group('meetings')]
[positional-arguments]
meeting-run agent *args:
    "{{meeting_kit}}" run "$@"
