// Bundle the hosted HTTP server (src/http.ts + all npm dependencies) into ONE file:
//   dist/http.bundle.mjs
// It needs only esbuild (a regular dependency), not TypeScript or any devDependency, so it works on a
// host that installs production dependencies only. server.js (the Hostinger entry file) imports it.
//
//   node scripts/bundle.mjs        (also run by `npm run build` and `npm run bundle`)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "http.bundle.mjs");

await build({
  entryPoints: [join(root, "src", "http.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
  // Express and friends are CommonJS and call require("path") etc. Give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __ptCreateRequire } from 'node:module'; const require = __ptCreateRequire(import.meta.url);",
  },
});
console.log(`bundled -> ${outfile}`);
