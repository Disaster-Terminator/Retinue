#!/usr/bin/env node

const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "0");
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(delayMs);

const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "fake-session-1";

console.error(`fake-claude cwd=${process.cwd()}`);

if (exitCode === 0) {
  console.log(
    JSON.stringify({
      type: "result",
      result: `fake result: ${prompt}`,
      session_id: sessionId
    })
  );
} else {
  console.error(`fake failure: ${exitCode}`);
}

process.exit(exitCode);

