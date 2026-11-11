# The `meeting-kit` command, built from the kit's own source: in a consuming repository, the pinned flake input,
# never the repository itself, so the repository's content (meeting transcripts) never enters the Nix store.
#
# In the consuming repository's flake (with notebook-kit' nix/workspace.nix):
#
#   inputs.meeting-kit = { url = "github:danielnaab/meeting-kit/v0.1.0"; flake = false; };
#   ...
#   meetingKit = pkgs: import "${inputs.meeting-kit}/nix/package.nix" { inherit pkgs; bun = <a bun >= 1.2.21>; };
#   workspace = import "${inputs.notebook-kit}/nix/workspace.nix" {
#     inherit inputs flakeDir;
#     extraPackages = pkgs: [ (meetingKit pkgs) ];
#   };
#
# The scion (.scions/meeting-kit/) and this package come from the same pin, so what people read and what runs agree.
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
