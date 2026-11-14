# The `meeting-kit` command, built from the kit's own source: in a consuming repository, graft's store copy of the
# submodule, never the repository itself, so the repository's content (meeting transcripts) never enters the Nix store.
#
# graft.nix calls it with the kit's pinned bun; a repository that grafts the kit (graft v2.13.0 or later) gets it in
# its tools with no wiring of its own. The scion (scions/meeting-kit/) and this package are the same commit, so what
# people read and what runs agree.
{ pkgs, bun ? pkgs.bun }:
let
  kit = ../.;
in
pkgs.writeShellApplication {
  name = "meeting-kit";
  # git: the runner clones, commits and pushes. claude is found on PATH at run time (the worker installs it).
  runtimeInputs = [ bun pkgs.git ];
  text = ''
    exec bun ${kit}/src/cli.ts "$@"
  '';
  meta.description = "meeting-kit: run the meeting agents, render the Windmill tree, check the config";
}
