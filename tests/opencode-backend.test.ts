import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeBackend } from "../src/backends/opencode/backend.js";
import { OpenCodeClient } from "../src/backends/opencode/client.js";
import { getJobPaths, getRetinueTracePath } from "../src/core/paths.js";
import type { JobMeta, JobStatus, JobStatusResult } from "../src/core/types.js";
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
      externalSessionId: expect.stringMatching(/^ses_/),
      externalParentSessionId: expect.stringMatching(/^ses_/),
      externalChildSessionIds: [expect.stringMatching(/^ses_/)]
    });
    expect(started.externalSessionId).not.toBe(started.externalParentSessionId);
    expect(started.promptPath).toMatch(/prompt\.md$/);
    await expect(fs.readFile(started.promptPath, "utf8")).resolves.toBe("hello");
    expect(extractPromptText(server!.promptRequests.at(-1))).toBe("hello");

    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      backend: "opencode",
      externalSessionId: started.externalSessionId
    });
  });

  it("uses a shared OpenCode root session as the default run path", async () => {
    const backend = createBackend();

    const started = await backend.run({
      cwd: tempDir,
      prompt: "review this repository",
      title: "native demo",
      model: "local/test",
      agent: "explore"
    });

    expect(server!.sessionRequests.at(-2)).toMatchObject({
      directory: tempDir,
      title: "retinue-shared-root",
      agent: "build"
    });
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      directory: tempDir,
      title: "native demo",
      parentID: started.externalParentSessionId,
      agent: "explore",
      model: { providerID: "local", id: "test" }
    });
    expect(server!.promptRequests.at(-1)).toMatchObject({
      agent: "explore",
      model: { providerID: "local", modelID: "test" },
      parts: [{ type: "text", text: "review this repository" }]
    });
    await expect(new OpenCodeClient(server!.url).children(started.externalParentSessionId!)).resolves.toContainEqual(
      expect.objectContaining({ id: started.externalSessionId, parentID: started.externalParentSessionId, agent: "explore" })
    );
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      externalSessionId: started.externalSessionId,
      externalParentSessionId: started.externalParentSessionId,
      externalChildSessionIds: [started.externalSessionId]
    });
  });

  it("can reuse one OpenCode root session for multiple child jobs by default", async () => {
    const backend = createBackend();

    const first = await backend.run({
      cwd: tempDir,
      prompt: "review package scripts",
      title: "shared demo one",
      agent: "explore"
    });
    const second = await backend.run({
      cwd: tempDir,
      prompt: "review mcp surface",
      title: "shared demo two",
      agent: "explore"
    });

    expect(first.externalRunnerMode).toBe("shared-root");
    expect(second.externalRunnerMode).toBe("shared-root");
    expect(first.externalRootAgent).toBe("build");
    expect(second.externalRootAgent).toBe("build");
    expect(first.externalRootSessionId).toBe(first.externalParentSessionId);
    expect(second.externalRootSessionId).toBe(first.externalRootSessionId);
    expect(second.externalParentSessionId).toBe(first.externalParentSessionId);
    expect(first.externalSessionId).not.toBe(second.externalSessionId);
    expect(server!.sessionRequests).toHaveLength(3);
    expect(server!.sessionRequests[0]).toMatchObject({
      directory: tempDir,
      title: "retinue-shared-root",
      agent: "build"
    });
    expect(server!.sessionRequests[1]).toMatchObject({
      directory: tempDir,
      parentID: first.externalRootSessionId,
      agent: "explore"
    });
    expect(server!.sessionRequests[2]).toMatchObject({
      directory: tempDir,
      parentID: first.externalRootSessionId,
      agent: "explore"
    });
    await expect(new OpenCodeClient(server!.url).children(first.externalRootSessionId!)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.externalSessionId, parentID: first.externalRootSessionId }),
        expect.objectContaining({ id: second.externalSessionId, parentID: first.externalRootSessionId })
      ])
    );
  });

  it("rejects Codex model names passed as OpenCode child agents before creating sessions", async () => {
    const backend = createBackend();

    await expect(
      backend.run({
        cwd: tempDir,
        prompt: "review this repository",
        title: "wrong agent namespace",
        agent: "codex-gpt-5.5"
      })
    ).rejects.toThrow(/Unsupported OpenCode child agent "codex-gpt-5\.5".*backend agent name for OpenCode.*explore.*general/s);

    expect(server!.sessionRequests).toHaveLength(0);
    expect(server!.promptRequests).toHaveLength(0);
  });

  it("rejects Retinue backend names passed as OpenCode child agents before creating sessions", async () => {
    const backend = createBackend();

    await expect(
      backend.run({
        cwd: tempDir,
        prompt: "review this repository",
        title: "wrong backend namespace",
        agent: "opencode"
      })
    ).rejects.toThrow(
      /Unsupported OpenCode child agent "opencode".*"opencode" is a Retinue backend name; select the backend with RETINUE_BACKEND.*use agent only for one OpenCode agent.*explore.*general/s
    );

    expect(server!.sessionRequests).toHaveLength(0);
    expect(server!.promptRequests).toHaveLength(0);
  });

  it("rejects unknown OpenCode root agents before creating sessions", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_ROOT_AGENT: "codex-gpt-5.5" } as NodeJS.ProcessEnv);

    await expect(
      backend.run({
        cwd: tempDir,
        prompt: "review this repository",
        title: "wrong root agent namespace",
        agent: "explore"
      })
    ).rejects.toThrow(/Unsupported OpenCode root agent "codex-gpt-5\.5".*backend agent name for OpenCode.*build.*explore.*general.*plan/s);

    expect(server!.sessionRequests).toHaveLength(0);
    expect(server!.promptRequests).toHaveLength(0);
  });

  it("keeps per-spawn available as an explicit legacy mode", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_ROOT_BINDING_MODE: "per_spawn" } as NodeJS.ProcessEnv);

    const first = await backend.run({
      cwd: tempDir,
      prompt: "review package scripts",
      title: "legacy demo one",
      agent: "explore"
    });
    const second = await backend.run({
      cwd: tempDir,
      prompt: "review mcp surface",
      title: "legacy demo two",
      agent: "explore"
    });

    expect(first.externalRunnerMode).toBe("per-spawn");
    expect(second.externalRunnerMode).toBe("per-spawn");
    expect(second.externalRootSessionId).not.toBe(first.externalRootSessionId);
    expect(first.externalSessionId).not.toBe(second.externalSessionId);
    expect(server!.sessionRequests).toHaveLength(4);
    expect(server!.sessionRequests[0]).toMatchObject({
      directory: tempDir,
      title: "legacy demo one",
      agent: "build"
    });
    expect(server!.sessionRequests[1]).toMatchObject({
      directory: tempDir,
      parentID: first.externalRootSessionId,
      agent: "explore"
    });
    expect(server!.sessionRequests[2]).toMatchObject({
      directory: tempDir,
      title: "legacy demo two",
      agent: "build"
    });
    expect(server!.sessionRequests[3]).toMatchObject({
      directory: tempDir,
      parentID: second.externalRootSessionId,
      agent: "explore"
    });
  });

  it("can select the OpenCode root agent without changing the child agent", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_ROOT_AGENT: "plan" } as NodeJS.ProcessEnv);

    const started = await backend.run({
      cwd: tempDir,
      prompt: "review package scripts",
      title: "root agent demo",
      agent: "explore"
    });

    expect(started.externalRunnerMode).toBe("shared-root");
    expect(started.externalRootAgent).toBe("plan");
    expect(server!.sessionRequests[0]).toMatchObject({
      directory: tempDir,
      title: "retinue-shared-root",
      agent: "plan"
    });
    expect(server!.sessionRequests[1]).toMatchObject({
      directory: tempDir,
      parentID: started.externalRootSessionId,
      agent: "explore"
    });
  });

  it("reports unreachable OpenCode backend without marking job metadata corrupted", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "hello" });
    await server!.close();
    server = undefined;

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({
      jobId: started.jobId,
      status: "backend_unreachable",
      error: expect.any(String)
    });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      jobId: started.jobId,
      status: "backend_unreachable",
      error: expect.any(String)
    });
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      status: "backend_unreachable",
      externalSessionId: started.externalSessionId
    });
    await expect(fs.readFile(getRetinueTracePath(tempDir), "utf8")).resolves.toContain('"event":"opencode_job_backend_unreachable"');
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain(
      '"event":"opencode_job_backend_unreachable"'
    );
  });

  it("delegates read-only behavior to the selected OpenCode agent without prompt or tool overrides", async () => {
    const backend = createBackend();

    await backend.run({
      cwd: tempDir,
      prompt: "inspect only",
      readOnly: true
    });

    expect(server!.promptRequests.at(-1)).toMatchObject({ agent: "explore" });
    expect(server!.promptRequests.at(-1)).not.toHaveProperty("tools");
    const submittedPrompt = extractPromptText(server!.promptRequests.at(-1));
    expect(submittedPrompt).toBe("inspect only");
    expect(submittedPrompt).not.toContain("Retinue read-only child agent");
  });

  it("treats OpenCode patch and write tool parts as diagnostics rather than Retinue read-only policy", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "review text");
    server!.appendWriteIntentAssistant(started.externalSessionId!, "write");
    server!.completeSessionWithFinalText(started.externalSessionId!, "final review");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      stdout: "final review",
      parsedStdout: { result: "final review" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"patchPartCount":1');
    expect(trace).toContain('"writeIntentToolPartCount":1');
    expect(trace).toContain('"type":"patch"');
  });

  it("classifies OpenCode provider errors without read-only policy overlays", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendErroredPatchAssistant(started.externalSessionId!, {
      name: "APIError",
      data: {
        message: "Authentication Error,",
        statusCode: 401,
        metadata: { url: "http://127.0.0.1:4000/v1/chat/completions" }
      }
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: { result: expect.stringContaining("Authentication Error") },
      error: expect.stringContaining("127.0.0.1:4000")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_error"');
    expect(trace).toContain('"patchPartCount":1');
    expect(trace).toContain("Authentication Error");
    expect(trace).toContain("127.0.0.1:4000");
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

  it("keeps the OpenCode server alive while a stalled sibling is unresolved", async () => {
    const idleShutdowns: Array<{ baseUrl: string; cwd?: string }> = [];
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      onServerIdle: (baseUrl, cwd) => idleShutdowns.push({ baseUrl, cwd })
    });
    const first = await backend.run({ cwd: tempDir, prompt: "finish without closing server" });
    const stalled = await writeOpenCodeJobMeta(tempDir, "job_stalled_same_server", "stalled");
    await fs.writeFile(
      getJobPaths(tempDir, stalled.jobId).meta,
      `${JSON.stringify({ ...stalled, externalServerUrl: server!.url, externalSessionId: "ses_stalled" }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(getJobPaths(tempDir, stalled.jobId).stdout, "partial stalled advisory text\n", "utf8");

    server!.completeSession(first.externalSessionId!);
    await expect(backend.status({ jobId: first.jobId })).resolves.toMatchObject({ status: "completed" });

    expect(idleShutdowns).toEqual([]);
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

  it("persists completed result text during status reconciliation before backend loss", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "cache before backend loss" });
    server!.completeSessionWithFinalText(started.externalSessionId!, "cached final review");

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stdout, "utf8")).resolves.toBe("cached final review");

    await server!.close();
    server = undefined;

    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      stdout: "cached final review",
      parsedStdout: { result: "cached final review" }
    });
  });

  it("returns structured backend-unreachable when completed result text was never cached", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "completed without text" });
    server!.completeSession(started.externalSessionId!);

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "completed" });
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stdout, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await server!.close();
    server = undefined;

    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "backend_unreachable",
      error: expect.stringContaining("completed job result was not cached")
    });
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

  it("marks reasoning-only stop assistant messages as stalled", async () => {
    const backend = createBackend({
      RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
    } as NodeJS.ProcessEnv);
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "visible answer please" });
    server!.completeSessionWithReasoningOnly(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"backend_no_final_text"');
    expect(trace).toContain('"emptyAssistantRounds":1');
    expect(trace).toContain('"baselineMessageCount":0');
    expect(trace).toContain('"lastMessageInfoKeys":["finish","id","role","sessionID","time"]');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","reasoning","step-finish"]');
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain('"event":"opencode_job_stalled"');
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("empty assistant round"),
      parsedStdout: { result: expect.stringContaining("empty assistant round") },
      error: expect.stringContaining("empty assistant round")
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
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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

  it("marks completed tool-call loops as stalled before the generic long stall threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "600000",
        RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect git status and summarize" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status three");

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"tool_loop_no_completion"');
    expect(trace).toContain('"toolCallAssistantRounds":3');
    expect(trace).toContain('"runningReadToolParts":0');
    expect(trace).toContain('"completedToolLoopStallThresholdMs":1');
    expect(trace).toContain('"stallThresholdMs":600000');
  });

  it("starts a fresh task-level attempt when completed tool loops stall without final text", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "600000",
        RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect repeatedly then summarize", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status three");
    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    await waitForPromptCount(2);
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);

    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(waited.jobId).not.toBe(started.jobId);
    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, waited.jobId).meta, "utf8")) as JobMeta;
    expect(attempt).toMatchObject({
      recoveredFromJobId: started.jobId,
      attempt: 1,
      recoveryReason: "tool_loop_no_completion",
      recoveryPolicy: "fresh_task_attempt",
      originalStallReason: "tool_loop_no_completion",
      recoveryStallReason: "tool_loop_no_completion"
    });
  });

  it("marks empty stop assistant rounds as stalled with diagnostics", async () => {
    const backend = createBackend({
      RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
    } as NodeJS.ProcessEnv);
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
    expect(trace).toContain('"stallEmptyAssistantRoundThreshold":1');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","step-finish"]');
  });

  it("can return running at the wait deadline before status records the no-final-text stall", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect docs and summarize near deadline" });
    setTimeout(() => {
      server!.appendEmptyStopAssistant(started.externalSessionId!);
    }, 20);

    await expect(backend.wait({ jobId: started.jobId }, 50)).resolves.toMatchObject({ status: "running" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "stalled" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"backend_no_final_text"');
  });

  it("marks blank provider assistant placeholders as stalled with diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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

  it("uses a short default stall window for blank provider assistant placeholders", async () => {
    const backend = createBackend({
      RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
    } as NodeJS.ProcessEnv);
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "provider returned a blank assistant placeholder" });
    server!.appendBlankAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 130_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"blankAssistantStallThresholdMs":45000');
  });

  it("starts a fresh task-level attempt for blank provider assistant placeholders after tool rounds", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "docs review ends in blank output after tools" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking package docs");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking packaged skill");
    server!.appendBlankAssistant(started.externalSessionId!);
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);
    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(waited.jobId).not.toBe(started.jobId);

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"blankAssistantRounds":1');
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
    expect(server!.promptRequests).toHaveLength(2);
  });

  it("returns stalled for blank provider assistant placeholders when fresh attempts are disabled", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "blank provider needs rescue time" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking package docs");
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "stalled" });
    expect(server!.promptRequests).toHaveLength(1);

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
  });

  it("keeps blank finalization placeholders running after completed tool progress within the finalization window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "60000",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review has tool evidence then blank final answer placeholder" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({ status: "running" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).not.toContain('"event":"opencode_task_level_attempt_started"');
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("starts a fresh task-level attempt for completed tool loops without final text", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect repeatedly then summarize", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking status three");
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);

    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(waited.jobId).not.toBe(started.jobId);
    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, waited.jobId).meta, "utf8")) as JobMeta;
    expect(attempt).toMatchObject({
      recoveredFromJobId: started.jobId,
      attempt: 1,
      recoveryReason: "tool_loop_no_completion",
      recoveryPolicy: "fresh_task_attempt",
      originalStallReason: "tool_loop_no_completion",
      recoveryStallReason: "tool_loop_no_completion"
    });
  });

  it("starts a fresh task-level attempt for first-turn blank provider output", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "provider fails before any tool progress" });
    server!.appendBlankAssistant(started.externalSessionId!);

    const firstWait = await backend.wait({ jobId: started.jobId }, 100);
    expect(firstWait).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(firstWait.jobId).not.toBe(started.jobId);
    expect(firstWait.status).toBe("running");
    expect(server!.promptRequests).toHaveLength(2);

    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, firstWait.jobId).meta, "utf8")) as JobMeta;
    server!.completeSessionWithFinalText(attempt.externalSessionId!, "fresh retry review");
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
      jobId: firstWait.jobId,
      requestedJobId: started.jobId,
      selectedAttemptJobId: firstWait.jobId,
      status: "completed"
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"toolCallAssistantRounds":0');
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
    expect(trace).toContain('"recoveryReason":"provider_blank_assistant"');
  });

  it("starts a fresh task-level attempt for zero-progress reasoning placeholders", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review keeps thinking without output" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);
    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(waited.jobId).not.toBe(started.jobId);

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantRounds":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","reasoning"]');
    expect(trace).toContain('"textBytes":0');
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
    expect(trace).toContain('"recoveryReason":"provider_zero_progress"');
    expect(server!.promptRequests).toHaveLength(2);
  });

  it("returns stalled for zero-progress reasoning placeholders when fresh attempts are disabled", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review keeps thinking without output" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).not.toContain('"event":"opencode_task_level_attempt_started"');
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("keeps finalization placeholders running after completed tool progress within the finalization window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "60000",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review has tool evidence then slow final answer" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);
    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 5_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({ status: "running" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).not.toContain('"event":"opencode_task_level_attempt_started"');
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("keeps empty text finalization placeholders running after completed tool progress within the finalization window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "60000",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review has tool evidence then empty text finalization placeholder" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendEmptyTextAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({ status: "running" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).not.toContain('"event":"opencode_task_level_attempt_started"');
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("prefers late root completion over a selected task-level attempt", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "audit eventually completes on root", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);
    const selected = await backend.wait({ jobId: started.jobId }, 200);

    expect(selected).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(selected.jobId).not.toBe(started.jobId);

    server!.completeSessionWithFinalText(started.externalSessionId!, "late root review");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
      jobId: started.jobId,
      status: "completed"
    });
    const result = await backend.result({ jobId: started.jobId });
    expect(result).toMatchObject({
      jobId: started.jobId,
      status: "completed",
      parsedStdout: { result: "late root review" },
      attemptChain: [
        expect.objectContaining({ jobId: started.jobId, attempt: 0, status: "completed", selected: true }),
        expect.objectContaining({ jobId: selected.selectedAttemptJobId, attempt: 1, selected: false })
      ]
    });
    expect(result.selectedAttemptJobId).toBeUndefined();
  });

  it("prefers parent completion observed while waiting on a selected task-level attempt", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "audit completes while selected attempt stalls", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);
    const selected = await backend.wait({ jobId: started.jobId }, 200);
    expect(selected.jobId).not.toBe(started.jobId);

    const selectedMeta = JSON.parse(await fs.readFile(getJobPaths(tempDir, selected.jobId).meta, "utf8")) as JobMeta;
    server!.appendMalformedReadToolAssistant(selectedMeta.externalSessionId!);
    setTimeout(() => server!.completeSessionWithFinalText(started.externalSessionId!, "late parent review"), 10);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
      jobId: started.jobId,
      status: "completed"
    });
  });

  it("marks default zero-progress placeholders as stalled after the bounded no-progress window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit pauses after many tools" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 130_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: {
        result: expect.stringContaining("final assistant output made no visible progress after completed tool calls")
      }
    });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=plan mode=plan");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantStallThresholdMs":45000');
  });

  it("marks unknown-finish empty step-finish assistant rounds as zero-progress", async () => {
    const backend = createBackend({
      RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
      RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
    } as NodeJS.ProcessEnv);
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "deep returned an empty assistant step" });
    server!.appendZeroProgressFinishedAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 60_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantRounds":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm-cloud"');
    expect(trace).toContain('"lastAssistantModelID":"deep"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","step-finish"]');
  });

  it("marks jobs with no assistant output as zero-progress after the bounded no-progress window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "provider never starts answering" });
    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 60_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"jobCompletedAssistantCount":0');
  });

  it("keeps killed jobs terminal even if the OpenCode session still looks running", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "closed locally" });
    const paths = getJobPaths(tempDir, started.jobId);
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...started, status: "killed", updatedAt: new Date().toISOString() })}\n`, "utf8");

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
  });

  it("marks stuck read tool calls as stalled without shortening generic long-tool windows", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review gets stuck reading files" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendRunningReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("pending/running read tool call"),
      stderr: expect.stringContaining("call_"),
      parsedStdout: { result: expect.stringContaining("pending/running read tool call") },
      error: expect.stringContaining("pending/running read tool call")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"read_tool_stalled"');
    expect(trace).toContain('"runningReadToolParts":1');
    expect(trace).toContain('"runningReadToolCallIds":["call_');
    expect(trace).toContain('"runningReadToolPartSummaries":[{"type":"tool","tool":"read","callID":"call_');
    expect(trace).toContain('"stateStatus":"running"');
    expect(trace).toContain('"stateInput":{"type":"object","preview":"{\\"filePath\\":\\"src/backends/opencode/backend.ts\\"}"}');
    expect(trace).toContain('readToolCalls=call_');
    expect(trace).toContain('input={\\"filePath\\":\\"src/backends/opencode/backend.ts\\"}');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"tool":"read"');
    expect(trace).toContain('"stateStatus":"running"');
  });

  it("does not promote a recorded read-tool stall when OpenCode later completes", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review gets stuck then later finishes" });
    server!.appendRunningReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const stalledResult = await backend.result({ jobId: started.jobId });
    expect(stalledResult.status).toBe("stalled");
    expect(stalledResult.stdout).toContain("pending/running read tool call");

    server!.completeSessionWithFinalText(started.externalSessionId!, "Late answer after Retinue already marked stalled.");

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("pending/running read tool call")
    });

    const persistedStdout = await fs.readFile(getJobPaths(tempDir, started.jobId).stdout, "utf8");
    expect(persistedStdout).toContain("pending/running read tool call");
    expect(persistedStdout).not.toContain("Late answer after Retinue already marked stalled.");
  });

  it("marks default pending read tool calls as stalled after the bounded read window", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "boundary audit reads deploy script" });
    server!.appendPendingReadToolAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 76_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: { result: expect.stringContaining("pending/running read tool call") }
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"read_tool_stalled"');
    expect(trace).toContain('"readToolStallThresholdMs":45000');
  });

  it("marks pending read tool calls as stalled with read-tool diagnostics", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review leaves read pending" });
    server!.appendPendingReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("pending/running read tool call"),
      parsedStdout: { result: expect.stringContaining("pending/running read tool call") },
      error: expect.stringContaining("pending/running read tool call")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"read_tool_stalled"');
    expect(trace).toContain('"runningReadToolParts":1');
    expect(trace).toContain('"runningReadToolCallIds":["call_');
    expect(trace).toContain('"runningReadToolPartSummaries":[{"type":"tool","tool":"read","callID":"call_');
    expect(trace).toContain('"stateStatus":"pending"');
    expect(trace).toContain('"stateInput":{"type":"object","preview":"{\\"filePath\\":\\"docs/how-to/verify.md\\"}"}');
    expect(trace).toContain('input={\\"filePath\\":\\"docs/how-to/verify.md\\"}');
  });

  it("classifies OpenCode external-directory permission waits separately from read-tool stalls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review reads outside the workspace" });
    server!.appendPendingReadToolAssistant(started.externalSessionId!);
    server!.appendExternalDirectoryPermission(started.externalSessionId!, "/home/raystorm/projects/opencode-runner/src/index.ts");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      permissionRequired: true,
      permissions: [
        expect.objectContaining({
          id: "per_1",
          permission: "external_directory",
          patterns: ["/home/raystorm/projects/opencode-runner/src/index.ts"],
          approval: expect.objectContaining({
            kind: "opencode_permission",
            title: "Access external directory /home/raystorm/projects/opencode-runner/src",
            lines: expect.arrayContaining([
              "Target: /home/raystorm/projects/opencode-runner/src",
              "Pattern: /home/raystorm/projects/opencode-runner/src/index.ts",
              `Delegated workspace: ${tempDir}`,
              "Scope: outside delegated workspace"
            ]),
            recommendedReply: "reject",
            recommendedMessage: expect.stringContaining("outside the delegated workspace"),
            scope: expect.objectContaining({
              target: "/home/raystorm/projects/opencode-runner/src",
              cwd: tempDir,
              relation: "outside_workspace"
            }),
            options: [
              expect.objectContaining({ reply: "once", label: "Allow once" }),
              expect.objectContaining({ reply: "always", label: "Allow always", requiresConfirmation: true }),
              expect.objectContaining({ reply: "reject", label: "Reject" })
            ]
          })
        })
      ],
      attentionRequired: {
        kind: "permission",
        backend: "opencode",
        reason: "external_directory_permission_pending",
        permissions: [
          expect.objectContaining({
            id: "per_1",
            permission: "external_directory",
            patterns: ["/home/raystorm/projects/opencode-runner/src/index.ts"],
            approval: expect.objectContaining({
              guidance: expect.arrayContaining([
                "Treat this as a supervisor decision for the blocked OpenCode child, not as child review evidence.",
                "Use reply=reject when the path or tool is outside the delegated task scope."
              ])
            })
          })
        ],
        replyOptions: ["once", "always", "reject"]
      },
      stdout: expect.stringContaining("external_directory permission"),
      parsedStdout: { result: expect.stringContaining("external_directory permission") },
      error: expect.stringContaining("external_directory permission")
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"external_directory_permission_pending"');
    expect(trace).toContain('"pendingExternalDirectoryPermissionCount":1');
    expect(trace).toContain('"permission":"external_directory"');
    expect(trace).toContain("/home/raystorm/projects/opencode-runner/src/index.ts");
  });

  it("replies to job-scoped OpenCode permission requests and reopens permission stalls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_STALL_COMPLETED_TOOL_LOOP_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review waits for permission" });
    server!.appendPendingReadToolAssistant(started.externalSessionId!);
    server!.appendExternalDirectoryPermission(started.externalSessionId!, "/home/raystorm/projects/opencode-runner/src/index.ts");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.listPermissions({ jobId: started.jobId })).resolves.toMatchObject({
      jobId: started.jobId,
      status: "stalled",
      permissions: [
        expect.objectContaining({
          id: "per_1",
          permission: "external_directory",
          patterns: ["/home/raystorm/projects/opencode-runner/src/index.ts"],
          approval: expect.objectContaining({
            title: "Access external directory /home/raystorm/projects/opencode-runner/src",
            recommendedReply: "reject",
            recommendedMessage: expect.stringContaining(`under ${tempDir}`)
          })
        })
      ]
    });

    await expect(backend.replyPermission({ jobId: started.jobId }, { requestId: "per_1", reply: "reject" })).resolves.toMatchObject({
      jobId: started.jobId,
      status: "running",
      repliedRequestId: "per_1",
      reply: "reject",
      permissions: []
    });
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });
    await expect(backend.listPermissions({ jobId: started.jobId })).resolves.toMatchObject({ permissions: [] });

    server!.appendFailedToolCallAssistant(started.externalSessionId!);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"tool_loop_no_completion"');
    expect(trace).toContain('"failedToolCallAssistantRounds":2');
  });

  it("does not expose sibling child permissions in shared-root mode", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_ROOT_BINDING_MODE: "shared_root",
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const first = await backend.run({ cwd: tempDir, prompt: "first review waits for permission" });
    const second = await backend.run({ cwd: tempDir, prompt: "second review stays isolated" });
    server!.appendPendingReadToolAssistant(first.externalSessionId!);
    server!.appendExternalDirectoryPermission(first.externalSessionId!, "/home/raystorm/projects/opencode-runner/src/index.ts");

    await expect(fs.readFile(getJobPaths(tempDir, second.jobId).meta, "utf8").then(JSON.parse)).resolves.toMatchObject({
      externalChildSessionIds: expect.arrayContaining([first.externalSessionId, second.externalSessionId])
    });
    await expect(backend.wait({ jobId: first.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.listPermissions({ jobId: second.jobId })).resolves.toMatchObject({
      jobId: second.jobId,
      permissions: []
    });
    await expect(backend.replyPermission({ jobId: second.jobId }, { requestId: "per_1", reply: "reject" })).rejects.toThrow(
      "not pending for Retinue job"
    );
    await expect(backend.listPermissions({ jobId: first.jobId })).resolves.toMatchObject({
      permissions: [expect.objectContaining({ id: "per_1", permission: "external_directory" })]
    });
  });

  it("classifies pending read tool calls with empty input as malformed provider tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review emits empty read input" });
    server!.appendMalformedReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.status).toBe("stalled");
    expect(result.stdout).toContain("missing or invalid input");
    expect(result.stdout).toContain("input={}");
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=explore mode=explore");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"read_tool_invalid_input"');
    expect(trace).toContain('"malformedReadToolParts":1');
    expect(trace).toContain('input={}');
  });

  it("starts a fresh task-level attempt for malformed read tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review emits empty read input", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source before malformed read");
    server!.appendMalformedReadToolAssistant(started.externalSessionId!);
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);

    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/),
      status: "running"
    });
    expect(waited.jobId).not.toBe(started.jobId);
    const original = JSON.parse(await fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8")) as JobMeta;
    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, waited.jobId).meta, "utf8")) as JobMeta;
    expect(original).toMatchObject({
      status: "stalled",
      selectedAttemptJobId: waited.jobId,
      attemptJobIds: [waited.jobId]
    });
    expect(attempt).toMatchObject({
      status: "running",
      recoveredFromJobId: started.jobId,
      attempt: 1,
      recoveryReason: "malformed_read_tool_call",
      recoveryPolicy: "fresh_task_attempt",
      originalStallReason: "read_tool_invalid_input"
    });
    server!.completeSession(attempt.externalSessionId!);
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
      jobId: waited.jobId,
      requestedJobId: started.jobId,
      status: "completed"
    });
    await expect(backend.result({ jobId: waited.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: expect.stringContaining("Retinue task-level retry request") },
      attemptChain: [
        expect.objectContaining({ jobId: started.jobId, attempt: 0, status: "stalled" }),
        expect.objectContaining({ jobId: waited.jobId, attempt: 1, selected: true })
      ]
    });
    const attemptPrompt = extractPromptText(server!.promptRequests.at(-1));
    expect(attemptPrompt).toContain("Attempt handoff capsule:");
    expect(attemptPrompt).toContain(`sourceJobId=${started.jobId}`);
    expect(attemptPrompt).toContain("trustedFinalText=false");
    expect(attemptPrompt).toContain("completed tool evidence:");
    expect(attemptPrompt).toContain("tool=task status=completed");
    expect(attemptPrompt).toContain("tool=read status=pending");
    expect(attemptPrompt).toContain("input={}");
    expect(attemptPrompt).toContain("Previous attempt emitted a malformed OpenCode read tool call");
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
    expect(trace).toContain('"handoffCapsule"');
    expect(trace).toContain('"trustedFinalText":false');
  });

  it("classifies pending non-read tool calls with empty input as malformed provider tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review emits empty grep input", agent: "explore" });
    server!.appendMalformedToolAssistant(started.externalSessionId!, "grep");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.status).toBe("stalled");
    expect(result.stdout).toContain("non-read tool call");
    expect(result.stdout).toContain("missing or invalid input");
    expect(result.stdout).toContain("toolCalls=grep:");
    expect(result.stdout).toContain("input={}");
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=explore mode=explore");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"tool_invalid_input"');
    expect(trace).toContain('"malformedToolParts":1');
    expect(trace).toContain('"malformedReadToolParts":0');
    expect(trace).toContain('"runningToolParts":1');
    expect(trace).toContain('"tool":"grep"');
    expect(trace).not.toContain('"stallReason":"incomplete_assistant_round"');
  });

  it("starts a fresh task-level attempt for malformed non-read tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review emits empty grep input", agent: "explore" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source before malformed grep");
    server!.appendMalformedToolAssistant(started.externalSessionId!, "grep");
    server!.setAutoAssistantResponses(true);

    const waited = await backend.wait({ jobId: started.jobId }, 1000);

    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/),
      status: "running"
    });
    expect(waited.jobId).not.toBe(started.jobId);
    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, waited.jobId).meta, "utf8")) as JobMeta;
    expect(attempt).toMatchObject({
      status: "running",
      recoveredFromJobId: started.jobId,
      attempt: 1,
      recoveryReason: "malformed_tool_call",
      recoveryPolicy: "fresh_task_attempt",
      originalStallReason: "tool_invalid_input"
    });
    const attemptPrompt = extractPromptText(server!.promptRequests.at(-1));
    expect(attemptPrompt).toContain("Attempt handoff capsule:");
    expect(attemptPrompt).toContain("Previous attempt emitted a malformed OpenCode tool call");
    expect(attemptPrompt).toContain("tool=grep status=pending");
    expect(attemptPrompt).toContain("input={}");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
    expect(trace).toContain('"recoveryReason":"malformed_tool_call"');
  });

  it("reports no usable conclusion when a malformed read retry is exhausted", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review repeatedly emits empty read input", agent: "explore" });
    server!.appendMalformedReadToolAssistant(started.externalSessionId!);

    const firstWait = await backend.wait({ jobId: started.jobId }, 1000);

    expect(firstWait).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/),
      status: "running"
    });
    const attempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, firstWait.jobId).meta, "utf8")) as JobMeta;
    server!.appendMalformedReadToolAssistant(attempt.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
      jobId: firstWait.jobId,
      requestedJobId: started.jobId,
      status: "stalled"
    });
    const result = await backend.result({ jobId: started.jobId });
    expect(result).toMatchObject({
      jobId: firstWait.jobId,
      status: "stalled"
    });
    expect(result.stdout).toContain("missing or invalid input");
    expect(result.stdout).toContain("Retinue task-level attempt budget exhausted");
    expect(result.stdout).toContain("No usable child-agent conclusion is available");
    expect(result.stdout).toContain(`root job ${started.jobId}`);
    expect(result.stdout).toContain(`selected attempt ${firstWait.jobId}`);
    expect(result.stdout).toContain("rootStall=read_tool_invalid_input");
    expect(result.stdout).toContain("recoveryStall=read_tool_invalid_input");
  });

  it("allows one extra default task-level attempt for repeated malformed read tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review repeatedly emits empty read input", agent: "explore" });
    server!.appendMalformedReadToolAssistant(started.externalSessionId!);

    const firstWait = await backend.wait({ jobId: started.jobId }, 1000);
    expect(firstWait).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/),
      status: "running"
    });
    const firstAttempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, firstWait.jobId).meta, "utf8")) as JobMeta;
    server!.appendMalformedReadToolAssistant(firstAttempt.externalSessionId!);

    const secondWait = await backend.wait({ jobId: started.jobId }, 1000);

    expect(secondWait).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/),
      status: "running"
    });
    expect(secondWait.jobId).not.toBe(firstWait.jobId);
    const original = JSON.parse(await fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8")) as JobMeta;
    const updatedFirstAttempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, firstWait.jobId).meta, "utf8")) as JobMeta;
    const secondAttempt = JSON.parse(await fs.readFile(getJobPaths(tempDir, secondWait.jobId).meta, "utf8")) as JobMeta;
    expect(original.attemptJobIds).toEqual([firstWait.jobId]);
    expect(updatedFirstAttempt).toMatchObject({
      status: "stalled",
      selectedAttemptJobId: secondWait.jobId,
      attemptJobIds: [secondWait.jobId],
      recoveryReason: "malformed_read_tool_call"
    });
    expect(secondAttempt).toMatchObject({
      status: "running",
      recoveredFromJobId: firstWait.jobId,
      attempt: 2,
      recoveryReason: "malformed_read_tool_call",
      originalStallReason: "read_tool_invalid_input"
    });
  });

  it("keeps blank finalization stalls on the original reason when fresh attempts are disabled", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review stalls blank after tool progress" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.status).toBe("stalled");
    expect(result.stdout).toContain("final assistant output made no visible progress after completed tool calls");
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=plan mode=plan");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(server!.promptRequests).toHaveLength(1);
  });

  it("does not submit no-tools rescue for stalled read tool executor calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review leaves read pending" });
    server!.appendPendingReadToolAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });

    expect(server!.promptRequests).toHaveLength(1);
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"read_tool_stalled"');
  });

  it("marks incomplete assistant tool rounds as stalled before the long-duration threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "600000",
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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

  it("classifies LiteLLM DeepSeek reasoning_content provider errors explicitly", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit hits DeepSeek reasoning-content error" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendErroredIncompleteAssistant(started.externalSessionId!, {
      name: "APIError",
      data: {
        message:
          'litellm.BadRequestError: DeepseekException - {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error","code":"invalid_request_error"}}. Received Model Group=semantic-router'
      },
      statusCode: 400
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: expect.stringContaining("DeepSeek reasoning_content")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_reasoning_content_error"');
    expect(trace).toContain("semantic-router");
    expect(trace).toContain("reasoning_content");
  });

  it("keeps default incomplete assistant tool rounds running before the incomplete stall threshold", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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

  it("keeps default incomplete assistant tool rounds recoverable before the bounded incomplete window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 30_000).toISOString() })}\n`, "utf8");

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

  it("keeps non-empty reasoning-only assistant streams running past the incomplete stall window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_INCOMPLETE_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "deep model streams reasoning before final text" });
    server!.appendReasoningOnlyIncompleteAssistant(started.externalSessionId!, "reasoning chunk ".repeat(300));

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 60_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    server!.completeSessionWithFinalText(started.externalSessionId!, "late answer after reasoning");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "late answer after reasoning" }
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"lastAssistantProviderID":"litellm-cloud"');
    expect(trace).toContain('"lastAssistantModelID":"deep"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","reasoning","text"]');
    expect(trace).toContain('"lastAssistantReasoningTextBytes":4800');
  });

  it("marks default no-final assistant tool rounds as stalled after the bounded tool-loop window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 46_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: { result: expect.stringContaining("tool-call assistant round") }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"incomplete_assistant_round"');
    expect(trace).toContain('"incompleteAssistantStallThresholdMs":45000');
  });

  it("keeps a single stale running tool call running before the bounded incomplete window by default", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "tool call never returns" });
    server!.appendIncompleteAssistant(started.externalSessionId!, "waiting for a tool");

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 30_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_wait_timeout"');
    expect(trace).not.toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"lastAssistantPartSummaries"');
    expect(trace).toContain('"stateStatus":"running"');
  });

  it("promotes a status-observed stalled OpenCode job when the backend later produces a final result", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_MS: "1",
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
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

    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "final audit result" }
    });
  });

  it("waits through recoverable OpenCode stalls before returning to the caller", async () => {
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
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit eventually answers during wait" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled"
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
  });

  it("returns stalled for zero-progress assistant output when fresh attempts are disabled", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_FINALIZATION_AFTER_TOOL_PROGRESS_MS: "1",
        RETINUE_OPENCODE_TASK_ATTEMPT_MAX: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit remains blank" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source before zero progress");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 250)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
  });

  it("starts a fresh task-level attempt for recoverable OpenCode stalls", async () => {
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
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit needs fresh attempt" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    server!.setAutoAssistantResponses(true);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const waited = await backend.wait({ jobId: started.jobId }, 1000);
    expect(waited).toMatchObject({
      requestedJobId: started.jobId,
      selectedAttemptJobId: expect.stringMatching(/^job_/)
    });
    expect(server!.promptRequests).toHaveLength(2);
    expect(extractPromptText(server!.promptRequests.at(-1))).toContain("Retinue task-level retry request");
    expect(server!.promptRequests.at(-1)?.tools).toBeUndefined();
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_task_level_attempt_started"');
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

  it("starts a new read-only OpenCode session instead of reusing an unverified session", async () => {
    const backend = createBackend();
    const first = await backend.run({ cwd: tempDir, prompt: "first" });

    const continued = await backend.continueJob({
      cwd: tempDir,
      prompt: "second",
      externalSessionId: first.externalSessionId,
      parentJobId: first.jobId,
      parentSessionId: first.externalSessionId,
      readOnly: true
    });

    expect(continued.externalSessionId).not.toBe(first.externalSessionId);
    expect(continued.parentJobId).toBe(first.jobId);
    expect(continued.parentSessionId).toBe(first.externalSessionId);
    expect(continued.readOnly).toBe(true);
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.arrayContaining([
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" }
      ])
    });
    expect(server!.sessionRequests.at(-1)?.permission).not.toContainEqual({
      permission: "edit",
      pattern: "blocked-by-plan",
      action: "deny"
    });
    await expect(backend.result({ jobId: continued.jobId })).resolves.toMatchObject({
      parsedStdout: { result: "fake result: second" }
    });
  });

  it("inherits parent session deny and external-directory rules for OpenCode child sessions", async () => {
    const backend = createBackend();
    const root = await backend.run({ cwd: tempDir, prompt: "root", agent: "general" });
    server!.setSessionPermission(root.externalRootSessionId!, [
      { permission: "external_directory", pattern: "/tmp/outside", action: "ask" },
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "edit", pattern: "root-agent-only", action: "allow" }
    ]);

    const child = await backend.run({
      cwd: tempDir,
      prompt: "child",
      readOnly: true
    });

    expect(child.externalSessionId).not.toBe(root.externalSessionId);
    expect(child.externalRootSessionId).toBe(root.externalRootSessionId);
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.arrayContaining([
        { permission: "external_directory", pattern: "/tmp/outside", action: "ask" },
        { permission: "bash", pattern: "rm *", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" }
      ])
    });
    expect(server!.sessionRequests.at(-1)?.permission).not.toContainEqual({
      permission: "edit",
      pattern: "root-agent-only",
      action: "allow"
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

  it("treats abort as best-effort when the OpenCode server is already gone", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "stop after server exits" });
    await server!.close();
    server = undefined;

    await expect(backend.abort({ jobId: started.jobId })).resolves.toBeUndefined();
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });

    const stderr = await fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8");
    expect(stderr).toContain('"event":"opencode_job_abort_failed"');
    expect(stderr).toContain('"event":"opencode_job_abort_marked_killed"');
  });

  it("keeps killed OpenCode jobs terminal when text arrives after abort", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "finish while closing" });

    await backend.abort({ jobId: started.jobId });
    server!.completeSessionWithFinalText(started.externalSessionId!, "late but usable result");

    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({ status: "killed" });
  });

  it("wait returns running before completion then completed after completion", async () => {
    const backend = createBackend();
    const started = await backend.run({ cwd: tempDir, prompt: "wait-me" });

    await expect(backend.wait({ jobId: started.jobId }, 1)).resolves.toMatchObject({ status: "running" });
    server!.completeSession(started.externalSessionId!);
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
  });

  it("does not let stale running OpenCode metadata block managed server idle shutdown", async () => {
    const idleServers: string[] = [];
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      onServerIdle: (baseUrl) => idleServers.push(baseUrl)
    });
    const started = await backend.run({ cwd: tempDir, prompt: "complete despite stale sibling" });
    const stale = await writeOpenCodeJobMeta(tempDir, "job_stale_running_same_server", "running");
    await fs.writeFile(
      getJobPaths(tempDir, stale.jobId).meta,
      `${JSON.stringify({ ...stale, externalServerUrl: server!.url, externalSessionId: "ses_missing" }, null, 2)}\n`,
      "utf8"
    );

    server!.completeSession(started.externalSessionId!);
    await expect(waitForJobStatus(backend, started.jobId, "completed")).resolves.toMatchObject({ status: "completed" });

    expect(idleServers).toEqual([server!.url]);
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

  function createBackend(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): OpenCodeBackend {
    return new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env
    });
  }

  async function waitForPromptCount(count: number): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((server?.promptRequests.length ?? 0) >= count) {
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for ${count} OpenCode prompt requests`);
  }

  async function waitForJobStatus(backend: OpenCodeBackend, jobId: string, status: JobStatus): Promise<JobStatusResult> {
    const deadline = Date.now() + 1000;
    let last: JobStatusResult | undefined;
    while (Date.now() < deadline) {
      last = await backend.status({ jobId });
      if (last.status === status) {
        return last;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for job ${jobId} to reach ${status}; last=${last?.status ?? "unknown"}`);
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

function extractPromptText(request: Record<string, unknown> | undefined): string {
  const parts = Array.isArray(request?.parts) ? request.parts : [];
  const first = parts[0];
  if (typeof first === "object" && first !== null && "text" in first) {
    return String((first as { text?: unknown }).text ?? "");
  }
  return "";
}
