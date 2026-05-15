import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeBackend } from "../src/backends/opencode/backend.js";
import { OpenCodeClient } from "../src/backends/opencode/client.js";
import { getJobPaths, getRetinueTracePath } from "../src/core/paths.js";
import type { JobMeta, JobStatus } from "../src/core/types.js";
import { startFakeOpenCodeServer, type FakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

describe("OpenCodeBackend", () => {
  let tempDir: string;
  let server: FakeOpenCodeServer | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-opencode-backend-"));
    server = await startFakeOpenCodeServer();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs OpenCode jobs and persists backend metadata", async () => {
    const backend = createBackend();

    const started = await backend.run({
      cwd: tempDir,
      prompt: "hello",
      title: "demo",
      model: "local/test",
      agent: "build"
    });

    expect(started).toMatchObject({
      backend: "opencode",
      status: "running",
      cwd: tempDir,
      title: "demo",
      model: "local/test",
      agent: "build",
      externalServerUrl: server!.url,
      externalSessionDirectory: process.cwd(),
      externalSessionId: expect.stringMatching(/^ses_/)
    });
    expect(started.promptPath).toMatch(/prompt\.md$/);
    await expect(fs.readFile(started.promptPath, "utf8")).resolves.toBe("hello");

    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      backend: "opencode",
      externalSessionId: started.externalSessionId
    });
  });

  it("creates read-only OpenCode sessions with tool disables and non-interactive permissions", async () => {
    const backend = createBackend();

    await backend.run({
      cwd: tempDir,
      prompt: "inspect only",
      readOnly: true
    });

    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.arrayContaining([
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "external_directory", pattern: "*", action: "deny" },
        { permission: "doom_loop", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "git show*", action: "allow" },
        { permission: "bash", pattern: "git diff*", action: "allow" },
        { permission: "bash", pattern: "git status*", action: "allow" }
      ])
    });
    expect(server!.promptRequests.at(-1)).toMatchObject({
      tools: {
        edit: false,
        write: false,
        apply_patch: false,
        task: false
      }
    });
  });

  it("stalls read-only OpenCode jobs that emit patch parts", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: { result: expect.stringContaining("OpenCode read-only job emitted patch/write intent") },
      error: expect.stringContaining("OpenCode read-only job emitted patch/write intent")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"patchPartCount":1');
    expect(trace).toContain('"readOnlyPatchPartCount":1');
    expect(trace).toContain('"readOnlyWriteIntent":true');
    expect(trace).toContain('"type":"patch"');
  });

  it("returns a job handle before a slow OpenCode prompt_async call finishes", async () => {
    server!.setPromptAsyncDelayMs(500);
    const backend = createBackend();

    const started = backend.run({
      cwd: tempDir,
      prompt: "slow prompt submission"
    });

    await expect(Promise.race([started.then(() => "started"), sleep(100).then(() => "timeout")])).resolves.toBe("started");
    const meta = await started;
    expect(meta).toMatchObject({ backend: "opencode", status: "running", cwd: tempDir });
    await expect(fs.readFile(getJobPaths(tempDir, meta.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      backend: "opencode",
      status: "running",
      externalSessionId: meta.externalSessionId
    });
    expect(server!.promptRequests).toHaveLength(0);

    await sleep(600);
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("returns failed from run when OpenCode prompt_async fails immediately", async () => {
    server!.setPromptAsyncFailure(500, { error: { message: "prompt submit broke" } });
    const backend = createBackend();

    const started = await backend.run({ cwd: tempDir, prompt: "will fail before submission" });

    expect(started).toMatchObject({ backend: "opencode", status: "failed" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "failed" });
    const stderr = await fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8");
    expect(stderr).toContain("opencode_job_prompt_failed");
    expect(stderr).toContain("prompt submit broke");
  });

  it("keeps newly started jobs running until fake completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "result please" });

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "running",
      sessionId: started.externalSessionId,
      parsedStdout: { result: "fake result: result please" }
    });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
  });

  it("transitions to completed after fake completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "result please" });
    server!.completeSession(started.externalSessionId!);

    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      sessionId: started.externalSessionId,
      parsedStdout: { result: "fake result: result please" }
    });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
  });

  it("schedules OpenCode server idle shutdown after the last running job becomes terminal", async () => {
    const idleShutdowns: Array<{ baseUrl: string; cwd?: string }> = [];
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      onServerIdle: (baseUrl, cwd) => idleShutdowns.push({ baseUrl, cwd })
    });
    const started = await backend.run({ cwd: tempDir, prompt: "finish and release server" });
    server!.completeSession(started.externalSessionId!);

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });

    expect(idleShutdowns).toEqual([{ baseUrl: server!.url, cwd: tempDir }]);
  });

  it("keeps the OpenCode server alive while another job is still running", async () => {
    const idleShutdowns: Array<{ baseUrl: string; cwd?: string }> = [];
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      onServerIdle: (baseUrl, cwd) => idleShutdowns.push({ baseUrl, cwd })
    });
    const first = await backend.run({ cwd: tempDir, prompt: "first" });
    const second = await backend.run({ cwd: tempDir, prompt: "second" });

    server!.completeSession(first.externalSessionId!);
    await expect(backend.status({ jobId: first.jobId })).resolves.toMatchObject({ status: "completed" });
    expect(idleShutdowns).toEqual([]);

    server!.completeSession(second.externalSessionId!);
    await expect(backend.status({ jobId: second.jobId })).resolves.toMatchObject({ status: "completed" });
    expect(idleShutdowns).toEqual([{ baseUrl: server!.url, cwd: tempDir }]);
  });

  it("records completed wait and result diagnostics for real E2E debugging", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "diagnose me" });
    server!.completeSession(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "fake result: diagnose me" }
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_status_changed"');
    expect(trace).toContain('"fromStatus":"running"');
    expect(trace).toContain('"toStatus":"completed"');
    expect(trace).toContain('"event":"opencode_job_result_read"');
    expect(trace).toContain('"jobMessageCount":2');
    expect(trace).toContain('"selectedAssistantTextBytes":24');

    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stdout, "utf8")).resolves.toBe("fake result: diagnose me");
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain('"event":"opencode_job_result_read"');
  });

  it("transitions to completed from completed assistant messages when session state is absent", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "result please" });
    server!.completeSessionByMessageOnly(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      sessionId: started.externalSessionId,
      parsedStdout: { result: "fake result: result please" }
    });
  });

  it("does not complete from reasoning-only assistant messages", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "visible answer please" });
    server!.completeSessionWithReasoningOnly(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).toContain('"baselineMessageCount":0');
    expect(trace).toContain('"lastMessageInfoKeys":["finish","id","role","sessionID","time"]');
    expect(trace).toContain('"lastAssistantPartTypes":["reasoning"]');
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain('"event":"opencode_job_wait_timeout"');
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "running",
      parsedStdout: { result: "" }
    });
  });

  it("does not complete from tool-call assistant messages with interim text", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "collect data then answer" });
    server!.completeSessionWithToolCallTextOnly(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","text","tool","step-finish"]');
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "running",
      parsedStdout: { result: "" }
    });
  });

  it("marks long-running tool-call loops as stalled with diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("OpenCode job stalled"),
      parsedStdout: { result: expect.stringContaining("OpenCode job stalled") },
      error: expect.stringContaining("OpenCode job stalled")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"tool_loop_no_completion"');
    expect(trace).toContain('"toStatus":"stalled"');
    expect(trace).toContain('"toolCallAssistantRounds":3');
    expect(trace).toContain('"lastMessagePartSummaries"');
    expect(trace).toContain('"tool":"task"');
    expect(trace).toContain('"stateStatus":"completed"');
    expect(trace).toContain('"noCompletedAssistantDurationMs"');
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain('"event":"opencode_job_stalled"');
  });

  it("marks empty stop assistant rounds as stalled with diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_EMPTY_ASSISTANT_ROUNDS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect docs and summarize" });
    server!.appendEmptyStopAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("empty assistant round"),
      parsedStdout: { result: expect.stringContaining("empty assistant round") },
      error: expect.stringContaining("empty assistant round")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"backend_no_final_text"');
    expect(trace).toContain('"emptyAssistantRounds":1');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","step-finish"]');
  });

  it("marks blank provider assistant placeholders as stalled with diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "provider is unavailable" });
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("blank assistant placeholder"),
      parsedStdout: { result: expect.stringContaining("blank assistant placeholder") },
      error: expect.stringContaining("blank assistant placeholder")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"blankAssistantRounds":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"lastAssistantPartTypes":[]');
  });

  it("marks zero-progress reasoning placeholders as stalled with diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review keeps thinking without output" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("zero-progress assistant placeholder"),
      parsedStdout: { result: expect.stringContaining("zero-progress assistant placeholder") },
      error: expect.stringContaining("zero-progress assistant placeholder")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantRounds":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","reasoning"]');
    expect(trace).toContain('"textBytes":0');
  });

  it("marks stuck read tool calls as stalled without shortening generic long-tool windows", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review gets stuck reading files" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendRunningReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("running read tool call"),
      parsedStdout: { result: expect.stringContaining("running read tool call") },
      error: expect.stringContaining("running read tool call")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"read_tool_stalled"');
    expect(trace).toContain('"runningReadToolParts":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"tool":"read"');
    expect(trace).toContain('"stateStatus":"running"');
  });

  it("marks incomplete assistant tool rounds as stalled before the long-duration threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "600000",
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit hangs mid-tool" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.appendIncompleteAssistant(started.externalSessionId!, "still checking");

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"incomplete_assistant_round"');
    expect(trace).toContain('"toolCallAssistantRounds":4');
    expect(trace).toContain('"incompleteAssistantRound":true');
    expect(trace).toContain('"incompleteAssistantStallThresholdMs":1');
  });

  it("includes bounded OpenCode assistant errors in stalled diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "600000",
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit hits provider error" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.appendErroredIncompleteAssistant(started.externalSessionId!, {
      message: "tool result channel closed",
      code: "transport_closed",
      details: "x".repeat(2000)
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"lastMessageError"');
    expect(trace).toContain("tool result channel closed");
    expect(trace).toContain("transport_closed");
    expect(trace).toContain('"truncated":true');
    expect(trace).toContain('"messageError"');
  });

  it("keeps default incomplete assistant tool rounds running before the incomplete stall threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit keeps using tools" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.appendIncompleteAssistant(started.externalSessionId!, "still checking");

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 30_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
  });

  it("keeps default incomplete assistant tool rounds running through realistic late-result windows", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit stops returning text" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.appendIncompleteAssistant(started.externalSessionId!, "still checking");

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 120_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    server!.completeSessionWithFinalText(started.externalSessionId!, "late final result");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "late final result" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
  });

  it("keeps default incomplete assistant tool rounds running after the old incomplete threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit stops returning text" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.appendIncompleteAssistant(started.externalSessionId!, "still checking");

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 181_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    server!.completeSessionWithFinalText(started.externalSessionId!, "late Windows gate review");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "late Windows gate review" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
  });

  it("keeps a single stale running tool call running before the long stall threshold by default", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "tool call never returns" });
    server!.appendIncompleteAssistant(started.externalSessionId!, "waiting for a tool");

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 181_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"lastAssistantPartSummaries"');
    expect(trace).toContain('"stateStatus":"running"');
  });

  it("recovers a stalled OpenCode job when the backend later produces a final result", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit eventually answers" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "stalled" });
    server!.completeSessionWithFinalText(started.externalSessionId!, "final audit result");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "final audit result" }
    });
  });

  it("does not reuse old completed assistant messages for continued jobs", async () => {
    const backend = createBackend();
    const first = await backend.run({ cwd: tempDir, prompt: "first" });
    server!.completeSessionByMessageOnly(first.externalSessionId!);
    await expect(backend.wait({ jobId: first.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });

    const continued = await backend.continueJob({
      cwd: tempDir,
      prompt: "second",
      externalSessionId: first.externalSessionId,
      parentJobId: first.jobId,
      parentSessionId: first.externalSessionId
    });

    await expect(backend.status({ jobId: continued.jobId })).resolves.toMatchObject({ status: "running" });
    await expect(backend.result({ jobId: continued.jobId })).resolves.toMatchObject({
      status: "running",
      parsedStdout: { result: "fake result: second" }
    });

    server!.completeSessionByMessageOnly(first.externalSessionId!);
    await expect(backend.wait({ jobId: continued.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
  });

  it("does not expose the current user prompt as result before an assistant response exists", async () => {
    server!.setAutoAssistantResponses(false);
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "do not echo me" });

    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "running",
      parsedStdout: { result: "" }
    });
  });

  it("continues an existing OpenCode session", async () => {
    const backend = createBackend();
    const first = await backend.run({ cwd: tempDir, prompt: "first" });
    const continued = await backend.continueJob({
      cwd: tempDir,
      prompt: "second",
      externalSessionId: first.externalSessionId,
      parentJobId: first.jobId,
      parentSessionId: first.externalSessionId
    });

    expect(continued.externalSessionId).toBe(first.externalSessionId);
    expect(continued.parentJobId).toBe(first.jobId);
    await expect(backend.result({ jobId: continued.jobId })).resolves.toMatchObject({
      parsedStdout: { result: "fake result: second" }
    });
  });

  it("continues an existing OpenCode session through the parent job server", async () => {
    const requestedCwds: Array<string | undefined> = [];
    const backend = new OpenCodeBackend({
      target: async (cwd) => {
        requestedCwds.push(cwd);
        return { client: new OpenCodeClient(server!.url), baseUrl: server!.url };
      },
      stateDir: tempDir
    });
    const first = await backend.run({ cwd: tempDir, prompt: "first" });

    const continued = await backend.continueJob({
      cwd: tempDir,
      prompt: "second",
      externalSessionId: first.externalSessionId,
      parentJobId: first.jobId
    });

    expect(continued.externalServerUrl).toBe(first.externalServerUrl);
    expect(requestedCwds).toEqual([tempDir]);
  });

  it("aborts OpenCode sessions", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "stop" });

    await backend.abort({ jobId: started.jobId });

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
  });

  it("recovers completed OpenCode text that arrives around an abort race", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "finish while closing" });

    await backend.abort({ jobId: started.jobId });
    server!.completeSessionWithFinalText(started.externalSessionId!, "late but usable result");

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "late but usable result" }
    });
  });

  it("wait returns running before completion then completed after completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "wait-me" });

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    server!.completeSession(started.externalSessionId!);
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
  });

  it("resolves the OpenCode target from the requested run cwd", async () => {
    const requestedCwds: Array<string | undefined> = [];
    const backend = new OpenCodeBackend({
      target: async (cwd) => {
        requestedCwds.push(cwd);
        return { client: new OpenCodeClient(server!.url), baseUrl: server!.url };
      },
      stateDir: tempDir
    });

    await backend.run({ cwd: tempDir, prompt: "target-cwd" });

    expect(requestedCwds).toEqual([tempDir]);
  });

  it("reconciles failed state from fake server", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "fail-me" });
    server!.failSession(started.externalSessionId!, "boom");
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "failed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "failed" });
  });

  it("cleans terminal OpenCode jobs and preserves running jobs", async () => {
    const backend = createBackend();
    const completed = await backend.run({ cwd: tempDir, prompt: "done" });
    const running = await backend.run({ cwd: tempDir, prompt: "keep" });
    server!.completeSession(completed.externalSessionId!);
    await backend.result({ jobId: completed.jobId });

    await expect(backend.cleanup()).resolves.toMatchObject({ removedJobIds: [completed.jobId] });

    await expect(fs.stat(getJobPaths(tempDir, completed.jobId).dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(getJobPaths(tempDir, running.jobId).dir)).resolves.toBeTruthy();
  });

  it("preserves uncertain OpenCode jobs during cleanup", async () => {
    const backend = createBackend();
    const completed = await backend.run({ cwd: tempDir, prompt: "done" });
    server!.completeSession(completed.externalSessionId!);
    await backend.result({ jobId: completed.jobId });
    const stalled = await writeOpenCodeJobMeta(tempDir, "job_opencode_stalled_cleanup", "stalled");
    const orphaned = await writeOpenCodeJobMeta(tempDir, "job_opencode_orphaned_cleanup", "orphaned");
    const abandoned = await writeOpenCodeJobMeta(tempDir, "job_opencode_abandoned_cleanup", "abandoned");

    const cleanup = await backend.cleanup({ olderThanMs: 0 });

    expect(cleanup.removedJobIds).toContain(completed.jobId);
    expect(cleanup.removedJobIds).not.toContain(stalled.jobId);
    expect(cleanup.removedJobIds).not.toContain(orphaned.jobId);
    expect(cleanup.removedJobIds).not.toContain(abandoned.jobId);
    await expect(fs.stat(getJobPaths(tempDir, stalled.jobId).dir)).resolves.toBeTruthy();
    await expect(fs.stat(getJobPaths(tempDir, orphaned.jobId).dir)).resolves.toBeTruthy();
    await expect(fs.stat(getJobPaths(tempDir, abandoned.jobId).dir)).resolves.toBeTruthy();
  });

  function createBackend(): OpenCodeBackend {
    return new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir
    });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeOpenCodeJobMeta(stateDir: string, jobId: string, status: JobStatus): Promise<JobMeta> {
  const paths = getJobPaths(stateDir, jobId);
  await fs.mkdir(paths.dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: JobMeta = {
    schemaVersion: 1,
    backend: "opencode",
    jobId,
    pid: -1,
    status,
    cwd: stateDir,
    promptPath: paths.prompt,
    promptPreview: status,
    promptSha256: status,
    externalSessionId: `ses_${jobId}`,
    externalServerUrl: "http://127.0.0.1:1",
    args: [],
    createdAt: now,
    updatedAt: now
  };
  await fs.writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}
