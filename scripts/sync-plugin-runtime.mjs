#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const rootDist = path.resolve("dist");
const pluginDist = path.resolve("plugins/anchorpoint/dist");

await fs.rm(pluginDist, { recursive: true, force: true });
await fs.cp(rootDist, pluginDist, { recursive: true });

process.stdout.write(`Synced plugin runtime to ${path.relative(process.cwd(), pluginDist)}\n`);
