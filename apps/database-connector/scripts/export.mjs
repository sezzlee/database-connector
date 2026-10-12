import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const connector = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(connector, "..", "..");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    push: { type: "boolean", default: false },
  },
});

const sh = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

const exported = [
  "apps/database-connector",
  "packages/contracts",
  "packages/credential-seal",
  "packages/database-runtime",
  "packages/oxlint-config",
  "vendor/mcp",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
];
if (sh("git", ["status", "--porcelain", "--", ...exported]) !== "")
  throw new Error(
    "Commit the exported paths first so SOURCE.json names what they hold",
  );

const out = resolve(
  values.out ?? (await mkdtemp(join(tmpdir(), "sezzlee-connector-export-"))),
);
await rm(out, { recursive: true, force: true });
sh("pnpm", [
  "exec",
  "turbo",
  "prune",
  "@chat/database-connector",
  "--out-dir",
  out,
]);

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/*
 * Guard: the public repository gets only the contract files the connector's
 * code reaches, so product schemas that never run in a customer's network do
 * not leave this repository. The closure follows `@chat/contracts/<leaf>`
 * imports from every connector-side package, tests included, then relative
 * imports inside the contracts.
 */
const contracts = join(out, "packages", "contracts");
const seeds = [
  ...(await files(join(out, "apps", "database-connector"))),
  ...(await files(join(out, "packages", "database-runtime"))),
  ...(await files(join(out, "packages", "credential-seal"))),
].filter((path) => !path.includes("node_modules"));
const keep = new Set();
const queue = [];
const visit = (path) => {
  if (keep.has(path)) return;
  keep.add(path);
  queue.push(path);
};
for (const seed of seeds)
  for (const [, leaf] of (await readFile(seed, "utf8")).matchAll(
    /["']@chat\/contracts\/([^"']+)["']/gu,
  ))
    visit(join(contracts, "src", `${leaf}.ts`));
while (queue.length > 0) {
  const path = queue.pop();
  for (const [, target] of (await readFile(path, "utf8")).matchAll(
    /from\s+["'](\.{1,2}\/[^"']+)["']/gu,
  ))
    visit(resolve(dirname(path), target));
}
for (const path of await files(join(contracts, "src")))
  if (!keep.has(path)) await rm(path);
await rm(join(contracts, "test"), { recursive: true, force: true });
const contractsManifest = JSON.parse(
  await readFile(join(contracts, "package.json"), "utf8"),
);
delete contractsManifest.dependencies["@json-render/core"];
delete contractsManifest.dependencies["json-render-mantine"];
contractsManifest.scripts["check-types"] = "tsc --noEmit";
delete contractsManifest.scripts.test;
delete contractsManifest.devDependencies.vitest;
await writeFile(
  join(contracts, "package.json"),
  `${JSON.stringify(contractsManifest, null, 2)}\n`,
);
await rm(join(contracts, "tsconfig.test.json"), { force: true });
await rm(join(out, "packages", "json-render-mantine"), {
  recursive: true,
  force: true,
});

const distribution = join(connector, "distribution");
await cp(distribution, out, { recursive: true });
await cp(
  join(root, "vendor", "mcp", "LICENSE"),
  join(out, "vendor", "mcp", "LICENSE"),
);

const workspace = await readFile(join(out, "pnpm-workspace.yaml"), "utf8");
await writeFile(
  join(out, "pnpm-workspace.yaml"),
  workspace.replace(
    /\nallowBuilds:[\s\S]*$/u,
    "\nallowBuilds:\n  esbuild: true\n",
  ),
);

await writeFile(
  join(out, "SOURCE.json"),
  `${JSON.stringify(
    {
      repository: "sezzlee/app",
      commit: sh("git", ["rev-parse", "HEAD"]),
      vendor: {
        repository: "sezzlee/mcp",
        commit: sh("git", ["rev-parse", "HEAD"], join(root, "vendor", "mcp")),
      },
    },
    null,
    2,
  )}\n`,
);

sh("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], out);

const unexpected = (await files(contracts))
  .map((path) => relative(contracts, path))
  .filter(
    (path) => path.startsWith("src/genui") || path.startsWith("src/auth"),
  );
if (unexpected.length > 0)
  throw new Error(
    `Product contracts reached the export: ${unexpected.join(", ")}`,
  );

process.stdout.write(`${out}\n`);

if (values.push) {
  const clone = await mkdtemp(join(tmpdir(), "sezzlee-connector-public-"));
  sh("git", [
    "clone",
    "--quiet",
    "https://github.com/sezzlee/database-connector.git",
    clone,
  ]);
  for (const entry of await readdir(clone))
    if (entry !== ".git")
      await rm(join(clone, entry), { recursive: true, force: true });
  await cp(out, clone, { recursive: true });
  sh("git", ["add", "--all"], clone);
  if (sh("git", ["status", "--porcelain"], clone) === "") {
    process.stdout.write("The public repository already holds this export\n");
  } else {
    sh(
      "git",
      [
        "commit",
        "--quiet",
        "-m",
        `Sync from sezzlee/app ${sh("git", ["rev-parse", "--short", "HEAD"])}`,
      ],
      clone,
    );
    sh("git", ["push", "--quiet", "origin", "HEAD:main"], clone);
    process.stdout.write(`Pushed ${sh("git", ["rev-parse", "HEAD"], clone)}\n`);
  }
}
