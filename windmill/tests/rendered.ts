// The kit's templates, rendered from examples/meeting-kit.yaml into a temporary windmill/ tree, as a consuming
// repository would commit it. The tests run against this tree, not the templates: it is what Windmill receives.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { writeTree } from "../../src/render/tree.ts";
import { renderTree } from "../../src/windmill/render.ts";

export const config = loadConfig(join(import.meta.dir, "../../examples"));
export const FOLDER = config.windmill.folder;

const dir = mkdtempSync(join(tmpdir(), "meeting-kit-rendered-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
writeTree(dir, [`f/${FOLDER}/`, "README.md"], renderTree(config));

/** The rendered windmill/ directory. */
export const ROOT = dir;
/** Its f/<folder>/. */
export const F = join(dir, "f", FOLDER);
/** The kit's own templates. */
export const TEMPLATES = join(import.meta.dir, "../f/meeting_kit");
