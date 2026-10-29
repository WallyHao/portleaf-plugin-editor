{
  description = "Portleaf development toolchain";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              pnpm
              electron
              nixfmt
              xvfb-run
              coreutils
              gnutar
              gzip
              util-linux
            ];

            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            PORTLEAF_ELECTRON = "${pkgs.electron}/bin/electron";
          };
        }
      );
    };
}
