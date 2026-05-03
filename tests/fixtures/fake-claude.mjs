#!/usr/bin/env node

const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "0");
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0");
const initialStdout = process.env.FAKE_CLAUDE_INITIAL_STDOUT;
const initialStderr = process.env.FAKE_CLAUDE_INITIAL_STDERR;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (initialStdout) {
  console.log(initialStdout);
}
if (initialStderr) {
  console.error(initialStderr);
}
await sleep(delayMs);

const promptIndex = process.argv.indexOf("-p");
const argvPrompt = promptIndex >= 0 && !process.argv[promptIndex + 1]?.startsWith("--") ? process.argv[promptIndex + 1] : "";
const stdin = await readStdin();
const prompt = argvPrompt || stdin.trim();
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : "fake-session-1";
const largeStdoutBytes = Number(process.env.FAKE_CLAUDE_LARGE_STDOUT_BYTES ?? "0");

console.error(`fake-claude cwd=${process.cwd()}`);

if (exitCode === 0) {
  if (largeStdoutBytes > 0) {
    console.log("x".repeat(largeStdoutBytes));
  }
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

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}
