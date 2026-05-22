#!/usr/bin/env node

import { main } from "../dist/cli/auditRetinueLogs.js";

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
