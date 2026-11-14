/**
 * meeting-kit: the kit's one command.
 *
 *   meeting-kit run <agent> [--input JSON] [--dry-run] [--keep] [--remote URL] [--mcp-config PATH] [--today DATE]
 *   meeting-kit render [--root DIR] [--check]    write (or check) the repository's windmill/ tree from its config
 *   meeting-kit check-config [--root DIR]        validate the repository's meeting-kit.yaml
 *   meeting-kit version                          the kit's version (CHANGELOG.md's newest heading)
 *
 * A consuming repository gets it in its graft tools (graft.nix builds nix/package.nix from graft's store copy of the
 * kit's submodule), never from its own source, so the repository's content never enters the Nix store.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const KIT_ROOT = resolve(import.meta.dir, "..");

export const USAGE = `usage: meeting-kit <command> [args]
  run <agent> [options]      run one meeting agent (meeting-kit run --help)
  render [--root DIR] [--check]
                             write the repository's windmill/ tree from meeting-kit.yaml (--check: report drift)
  check-config [--root DIR]  validate meeting-kit.yaml
  version                    print the kit's version`;

export function kitVersion(root = KIT_ROOT): string {
  const match = readFileSync(join(root, "CHANGELOG.md"), "utf8").match(/^## (v\d+\.\d+\.\d+\S*)/m);
  return match ? match[1]! : "unreleased";
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "run": {
      const { main: run } = await import("./runner/run.ts");
      return run(rest, {
        env: process.env,
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      });
    }
    case "render": {
      const { main: render } = await import("./windmill/render.ts");
      return render(rest);
    }
    case "check-config": {
      const { values } = parseArgs({ args: rest, options: { root: { type: "string", default: "." } } });
      const { loadConfig } = await import("./config/config.ts");
      try {
        const config = loadConfig(resolve(values.root!));
        console.log(`meeting-kit.yaml: valid (folder f/${config.windmill.folder}, agents ${config.agents.join(", ")})`);
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    case "version":
    case "--version":
      console.log(kitVersion());
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`unknown command ${command}\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
