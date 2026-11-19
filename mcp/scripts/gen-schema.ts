// Writes data/prayers.schema.json from the zod schema in src/schema.ts.
// Note: cross-field rules (refine/superRefine: exactly-one-of text/name, three-col
// requirements, uniqueness) cannot be expressed in JSON Schema; validateRoot() enforces them.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { RootSchema } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../data/prayers.schema.json");

const json = z.toJSONSchema(RootSchema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
const doc = {
  $schema: json.$schema,
  title: "Prayer Tower prayers.json",
  description:
    "Generated from mcp/src/schema.ts (npm run schema). Do not edit by hand. Cross-field rules (exactly one of text/name, three-col requirements, unique ids/nums) are enforced by validateRoot().",
  ...json,
};
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`wrote ${out}`);
