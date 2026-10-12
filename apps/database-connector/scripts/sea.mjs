import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { inject } from "postject";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "dist", "sea");

const { values } = parseArgs({
  options: {
    node: { type: "string" },
    "node-version": { type: "string" },
    out: { type: "string" },
  },
});

/*
 * Guard: a preparation blob is only promised to load in the Node release that
 * generated it, so a foreign target binary must name its release and match
 * the one running this script.
 */
if (values.node !== undefined && values["node-version"] !== process.version)
  throw new Error(
    `--node needs --node-version ${process.version}; build the blob with the target's Node release`,
  );

/*
 * Guard: the bundled MCP servers read their own package.json through
 * createRequire(import.meta.url), which a single file has no path for. Turning
 * the call into a plain require lets the bundler inline the manifest; any
 * other import.meta use surfaces as a warning, and warnings fail the build.
 */
const manifestRead =
  /createRequire\(import\.meta\.url\)\((["'][^"']+\.json["'])\)/g;
const inlineManifests = {
  name: "inline-manifests",
  setup(bundle) {
    bundle.onLoad({ filter: /\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      if (!source.includes("createRequire(import.meta.url)")) return undefined;
      return {
        contents: source.replace(manifestRead, "require($1)"),
        loader: "js",
        resolveDir: dirname(path),
      };
    });
  },
};

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const bundled = join(work, "connector.cjs");
const result = await build({
  entryPoints: [join(root, "dist", "cli.js")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: bundled,
  legalComments: "none",
  logLevel: "silent",
  plugins: [inlineManifests],
});
if (result.warnings.length > 0)
  throw new Error(
    result.warnings
      .map((warning) => `${warning.id}: ${warning.text}`)
      .join("\n"),
  );

const blob = join(work, "connector.blob");
const config = join(work, "sea-config.json");
await writeFile(
  config,
  JSON.stringify({
    main: bundled,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], {
  stdio: "ignore",
});

const source = values.node ?? process.execPath;
const header = Buffer.alloc(4);
const handle = await open(source, "r");
await handle.read(header, 0, 4, 0);
await handle.close();
const format =
  header.subarray(0, 2).toString("latin1") === "MZ"
    ? "pe"
    : header.toString("hex") === "7f454c46"
      ? "elf"
      : "macho";

const out = resolve(
  values.out ??
    join(work, `sezzlee-database-connector${format === "pe" ? ".exe" : ""}`),
);
await mkdir(dirname(out), { recursive: true });
await copyFile(source, out);
const signsHere = format === "macho" && process.platform === "darwin";
if (signsHere) execFileSync("codesign", ["--remove-signature", out]);
await inject(out, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: SEA_FUSE,
  ...(format === "macho" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (signsHere) execFileSync("codesign", ["--sign", "-", out]);
process.stdout.write(`${out}\n`);
