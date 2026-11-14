# meeting-kit as a graft provider (graft v2.13.0 or later): graft's mkFlake calls this once per system
# in a repository that grafts the kit as a git submodule, and adds `meeting-kit` to its tools
# (packages.<system>.tools, on PATH in the dev shell). The repository's flake names nothing of the kit.
#
# The command runs the kit from `scion`, graft's store copy of this submodule alone, so the
# repository's own content (meeting transcripts) never enters the Nix store. Its bun is pinned here,
# not taken from the repository's nixpkgs, so the kit runs on the bun it is tested with.
{ pkgs, lib, system, ... }:
let
  # nixos-25.11 at the revision this repository's flake.lock pins (bun 1.3.3); a fixed-output fetch,
  # allowed in pure evaluation. Move it with flake.lock, in a release.
  nixpkgs-bun = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/b6018f87da91d19d0ab4cf979885689b469cdd41.tar.gz";
    sha256 = "sha256-twXPFqFsrrY5r28Zh7Homgcp2gUMBgQ6WDS98Q/3xFI=";
  }) { inherit system; };
in
{
  tools.meeting-kit = import ./nix/package.nix { inherit pkgs; inherit (nixpkgs-bun) bun; };
}
