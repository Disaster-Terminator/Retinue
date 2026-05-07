#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const rootDist = path.resolve("dist");
const pluginDist = path.resolve("plugins/anchorpoint/dist");

await fs.rm(pluginDist, { recursive: true, force: true });
await fs.cp(rootDist, pluginDist, { recursive: true });
await esbuild.build({
  entryPoints: [path.resolve("src/mcp.ts")],
  outfile: path.join(pluginDist, "mcp.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true
});

process.stdout.write(`Synced plugin runtime to ${path.relative(process.cwd(), pluginDist)}\n`);
