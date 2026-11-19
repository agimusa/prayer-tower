// Hostinger "Entry file": starts the hosted Prayer Tower MCP server (Streamable HTTP + GitHub sign-in).
// It always calls main(), so it works however the host launches Node (directly or via a wrapper).
// dist/http.bundle.mjs is produced by `npm run bundle` (or `npm run build`); in the upload zip it is prebuilt.
// Configuration comes from environment variables; see HOSTING.md. Hostinger supplies PORT.
import { main } from "./dist/http.bundle.mjs";

main().catch((e) => {
  console.error(`[prayer-tower] fatal: ${String(e?.stack ?? e).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***")}`);
  process.exit(1);
});
