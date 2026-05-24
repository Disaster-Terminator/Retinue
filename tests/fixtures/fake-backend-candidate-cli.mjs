#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("fake-candidate 1.2.3\n");
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write("Commands: run server serve session export mcp permission json\n");
  process.exit(0);
}

process.stdout.write(`fake result args=${JSON.stringify(args)}\n`);
