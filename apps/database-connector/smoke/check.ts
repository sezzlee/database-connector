import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { databaseRuntimeResponseSchema } from "@chat/contracts/database/runtime";

const { values } = parseArgs({
  options: {
    log: { type: "string" },
    expect: { type: "string" },
    results: { type: "string", default: "1" },
  },
});
const lines = readFileSync(values.log ?? "", "utf8")
  .trim()
  .split("\n");
if (lines.length < Number(values.results))
  throw new Error(`expected ${values.results} results, got ${lines.length}`);
const responses = lines.map((line) =>
  databaseRuntimeResponseSchema.parse(JSON.parse(line).response),
);
for (const response of responses) {
  const outcome = response.ok
    ? response.result.kind === "test" &&
      response.result.readiness?.principal === "read_only"
      ? "connected_read_only"
      : `unexpected ${response.result.kind}`
    : response.error;
  if (outcome !== values.expect)
    throw new Error(`expected ${values.expect}, got ${outcome}`);
}
process.stdout.write(`${responses.length} result(s): ${values.expect}\n`);
