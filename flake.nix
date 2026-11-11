# The kit's development flake: its package, a dev shell, and the tests as a check. Consumers don't use it: they
# import nix/package.nix from their pin (flake = false), the way notebook-kit' nix/workspace.nix is used.
{
  description = "meeting-kit: content-neutral meeting agents (synthesis, triage, briefing) for Markdown work-memory vaults";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAll = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        meeting-kit = import ./nix/package.nix { inherit pkgs; };
        default = meeting-kit;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun pkgs.git pkgs.just ]; };
      });

      checks = forAll (pkgs: {
        tests = pkgs.runCommand "meeting-kit-tests" { nativeBuildInputs = [ pkgs.bun pkgs.git pkgs.bash pkgs.jq pkgs.curl pkgs.coreutils pkgs.gnused pkgs.gawk ]; } ''
          cp -r ${self} src && chmod -R u+w src && cd src
          export HOME=$TMPDIR
          git init -q && git add -A
          git -c user.name=t -c user.email=t@t commit -qm tests
          bun test
          touch $out
        '';
      });
    };
}
