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

  it("uses a direct OpenCode child session as the default run path", async () => {
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
      title: "native demo",
      agent: "build"
    });
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      directory: tempDir,
      title: "native demo",
      parentID: started.externalParentSessionId,
      agent: "explore",
      model: { providerID: "local", modelID: "test" }
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

  it("can reuse one OpenCode root session for multiple child jobs in shared-root mode", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_ROOT_BINDING_MODE: "shared_root" } as NodeJS.ProcessEnv);

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

  it("can select the OpenCode root agent without changing the child agent", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_ROOT_AGENT: "plan" } as NodeJS.ProcessEnv);

    const started = await backend.run({
      cwd: tempDir,
      prompt: "review package scripts",
      title: "root agent demo",
      agent: "explore"
    });

    expect(started.externalRunnerMode).toBe("per-spawn");
    expect(started.externalRootAgent).toBe("plan");
    expect(server!.sessionRequests[0]).toMatchObject({
      directory: tempDir,
      title: "root agent demo",
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
      status: "running",
      externalSessionId: started.externalSessionId
    });
  });

  it("creates read-only OpenCode sessions with readonly git bash and non-interactive permissions", async () => {
    const backend = createBackend();

    await backend.run({
      cwd: tempDir,
      prompt: "inspect only",
      readOnly: true,
      readOnlyPromptContract: true,
      readOnlyToolDeny: true
    });

    const permissions = server!.sessionRequests.at(-1)?.permission ?? [];
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.arrayContaining([
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "apply_patch", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "external_directory", pattern: "*", action: "deny" },
        { permission: "doom_loop", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "git diff --cached*", action: "allow" },
        { permission: "bash", pattern: "git diff --staged*", action: "allow" },
        { permission: "bash", pattern: "git status --short*", action: "allow" }
      ])
    });
    expect(permissions.findIndex((rule) => rule.permission === "bash" && rule.pattern === "git diff --cached*")).toBeLessThan(
      permissions.findIndex((rule) => rule.permission === "bash" && rule.pattern === "*")
    );
    expect(server!.promptRequests.at(-1)).toMatchObject({
      tools: {
        edit: false,
        write: false,
        apply_patch: false,
        task: false
      }
    });
    expect(server!.promptRequests.at(-1)?.tools).not.toHaveProperty("bash", false);
    const submittedPrompt = extractPromptText(server!.promptRequests.at(-1));
    expect(submittedPrompt).toContain("Retinue read-only child agent");
    expect(submittedPrompt).toContain("Use only OpenCode read, grep, glob, and allowed read-only git bash commands");
    expect(submittedPrompt).toContain("Allowed bash is limited to read-only git inspection commands");
    expect(submittedPrompt).toContain("read only a small set of targeted files");
    expect(submittedPrompt).toContain("Use read serially");
    expect(submittedPrompt).toContain("Do not emit unified diffs");
    expect(submittedPrompt).toContain("Do not include patch blocks");
    expect(submittedPrompt).toContain("For code review, return findings as plain text");
    expect(submittedPrompt).toContain("If the user provides enough facts");
    expect(submittedPrompt).toContain("Do not use tools just to confirm prompt-provided facts");
    expect(submittedPrompt).toContain("Use at most six inspection tool calls");
    expect(submittedPrompt).toContain("You cannot inspect git history");
    expect(submittedPrompt).toContain("Before using any tool, classify whether the user task depends on git-only state");
    expect(submittedPrompt).toContain("You may inspect staged or unstaged diff only with the allowed read-only git commands");
    expect(submittedPrompt).toContain("outside that allowlist");
    expect(submittedPrompt).toContain("If the task asks for a diff");
    expect(submittedPrompt).toContain("Do not call bash except for allowed read-only git inspection commands");
    expect(submittedPrompt).toContain("inspect only");
  });

  it("can opt read-only OpenCode sessions out of readonly git bash commands", async () => {
    const backend = createBackend();

    await backend.run({
      cwd: tempDir,
      prompt: "inspect staged diff",
      readOnly: true,
      readOnlyBashPolicy: "none",
      readOnlyPromptContract: true,
      readOnlyToolDeny: true
    });

    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.arrayContaining([
        { permission: "patch", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" }
      ])
    });
    expect(server!.sessionRequests.at(-1)).toMatchObject({
      permission: expect.not.arrayContaining([{ permission: "bash", pattern: "git diff --cached*", action: "allow" }])
    });
    expect(server!.promptRequests.at(-1)).toMatchObject({
      tools: {
        bash: false,
        edit: false,
        write: false,
        apply_patch: false,
        patch: false,
        task: false
      }
    });
    const submittedPrompt = extractPromptText(server!.promptRequests.at(-1));
    expect(submittedPrompt).toContain("Use only OpenCode read, grep, and glob tools");
    expect(submittedPrompt).toContain("Do not call bash");
    expect(submittedPrompt).toContain("Do not enter patch mode");
  });

  it("stalls read-only OpenCode jobs that emit patch parts", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" });
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

  it("classifies OpenCode provider errors before read-only patch intent", async () => {
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
    expect(trace).toContain('"readOnlyPatchPartCount":1');
    expect(trace).toContain('"readOnlyWriteIntent":false');
    expect(trace).toContain("Authentication Error");
    expect(trace).toContain("127.0.0.1:4000");
  });

  it("stalls read-only OpenCode jobs that attempt write-capable tools", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendWriteIntentAssistant(started.externalSessionId!, "write");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: { result: expect.stringContaining("OpenCode read-only job emitted patch/write intent") },
      error: expect.stringContaining("OpenCode read-only job emitted patch/write intent")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"readOnlyWriteIntent":true');
    expect(trace).toContain('"writeIntentToolPartCount":1');
    expect(trace).toContain('"tool":"write"');
  });

  it("returns pre-recovery final text only as advisory when read-only patch intent is rejected", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!);
    server!.completeSessionWithFinalText(started.externalSessionId!, "final review");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: "final review",
      parsedStdout: { result: "final review" },
      stderr: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only"),
      error: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only")
    });
  });

  it("returns incomplete read-only patch-intent text only as advisory when recovery fails", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "Finding: permission order is unsafe.");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: "Finding: permission order is unsafe.",
      parsedStdout: { result: "Finding: permission order is unsafe." },
      stderr: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only"),
      error: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only")
    });
  });

  it("recovers read-only patch intent only from a post-recovery final answer", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "Finding: original patch intent should be quarantined.");
    server!.completeSessionWithFinalText(started.externalSessionId!, "pre-recovery final text");
    const completeAfterRescue = waitForPromptCount(2).then(() => {
      server!.completeSessionWithFinalText(started.externalSessionId!, "recovered prose-only review");
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await completeAfterRescue;
    expect(server!.promptRequests).toHaveLength(2);
    expect(extractPromptText(server!.promptRequests.at(-1))).toContain("Retinue recovery request");
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      stdout: "recovered prose-only review",
      parsedStdout: { result: "recovered prose-only review" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
    expect(trace).toContain('"recoveredFromReadOnlyWriteIntent":true');
  });

  it("keeps read-only patch-intent recovery running until the post-recovery answer arrives", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "Finding: original patch intent should be quarantined.");

    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({ status: "running" });
    await waitForPromptCount(2);
    await expect(backend.status({ jobId: started.jobId })).resolves.toMatchObject({ status: "running" });

    server!.completeSessionWithFinalText(started.externalSessionId!, "recovered prose-only review");
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      stdout: "recovered prose-only review",
      parsedStdout: { result: "recovered prose-only review" }
    });
  });

  it("keeps read-only jobs stalled when recovery emits another patch intent", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "Finding: original patch intent.");
    const patchAfterRescue = waitForPromptCount(2).then(() => {
      server!.appendPatchAssistant(started.externalSessionId!, "Finding: recovery still tried to patch.");
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await patchAfterRescue;
    expect(server!.promptRequests).toHaveLength(2);
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      error: expect.stringContaining("OpenCode read-only job emitted patch/write intent")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
    expect(trace).toContain('"readOnlyWriteIntent":true');
  });

  it("returns read-only write-intent text as advisory stdout when recovery has no trusted final text", async () => {
    const backend = createBackend({
      RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
      RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    server!.appendPatchAssistant(started.externalSessionId!, "Finding: original patch intent.");
    const blankAfterRescue = waitForPromptCount(2).then(() => {
      server!.appendBlankAssistant(started.externalSessionId!);
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await blankAfterRescue;
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      stdout: "Finding: original patch intent.",
      stderr: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only"),
      error: expect.stringContaining("Retinue returned read-only write-intent text as advisory stdout only")
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"read_only_write_intent"');
    expect(trace).toContain('"recoveryStallReason":"provider_blank_assistant"');
    expect(trace).toContain('"readOnlyAdvisoryText":true');
  });

  it("flags patch-like text from completed read-only OpenCode jobs without hiding stdout", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect only", readOnly: true });
    const text = "Finding: risky change\n\n```diff\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n```";
    server!.completeSessionWithFinalText(started.externalSessionId!, text);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    const result = await backend.result({ jobId: started.jobId });
    expect(result).toMatchObject({
      status: "completed",
      stdout: text,
      stderr: expect.stringContaining("read-only result may contain patch or write-command text"),
      parsedStdout: { result: text }
    });
    expect(result.error).toBeUndefined();

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"readOnlyTextWarning":true');
    await expect(fs.readFile(getJobPaths(tempDir, started.jobId).stderr, "utf8")).resolves.toContain(
      "read-only result may contain patch or write-command text"
    );
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
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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

  it("marks empty stop assistant rounds as stalled with diagnostics", async () => {
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" } as NodeJS.ProcessEnv);
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

  it("returns stalled instead of running when a soft stall appears during a wait window", async () => {
    const backend = createBackend();
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "inspect docs and summarize near deadline" });
    setTimeout(() => {
      server!.appendEmptyStopAssistant(started.externalSessionId!);
    }, 20);

    await expect(backend.wait({ jobId: started.jobId }, 50)).resolves.toMatchObject({ status: "stalled" });
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
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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
    const backend = createBackend({ RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0" } as NodeJS.ProcessEnv);
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "provider returned a blank assistant placeholder" });
    server!.appendBlankAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 76_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"blankAssistantStallThresholdMs":45000');
  });

  it("rescues blank provider assistant placeholders after completed tool rounds", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "docs review ends in blank output after tools" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking package docs");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking packaged skill");
    server!.appendBlankAssistant(started.externalSessionId!);
    const completeAfterRescue = waitForPromptCount(2).then(() => {
      server!.completeSessionWithFinalText(started.externalSessionId!, "rescued blank-output review");
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await completeAfterRescue;
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "rescued blank-output review" }
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"blankAssistantRounds":1');
    expect(server!.promptRequests).toHaveLength(2);
  });

  it("keeps generic blank-provider recovery running during the rescue grace window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "60000"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "blank provider needs rescue time" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking package docs");
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "running" });
    expect(server!.promptRequests).toHaveLength(2);

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_pending"');
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
  });

  it("does not rescue first-turn blank provider output without tool progress", async () => {
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

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    expect(server!.promptRequests).toHaveLength(1);

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"stallReason":"provider_blank_assistant"');
    expect(trace).toContain('"toolCallAssistantRounds":0');
    expect(trace).not.toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
  });

  it("rescues zero-progress reasoning placeholders after completed tool rounds", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_ZERO_PROGRESS_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "risk review keeps thinking without output" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);
    const completeAfterRescue = waitForPromptCount(2).then(() => {
      server!.completeSessionWithFinalText(started.externalSessionId!, "rescued zero-progress review");
    });

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await completeAfterRescue;
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "rescued zero-progress review" }
    });

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantRounds":1');
    expect(trace).toContain('"lastAssistantProviderID":"litellm"');
    expect(trace).toContain('"lastAssistantModelID":"semantic-router"');
    expect(trace).toContain('"lastAssistantPartTypes":["step-start","reasoning"]');
    expect(trace).toContain('"textBytes":0');
    expect(server!.promptRequests).toHaveLength(2);
  });

  it("marks default zero-progress placeholders as stalled after the bounded no-progress window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit pauses after many tools" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendZeroProgressReasoningAssistant(started.externalSessionId!);

    const paths = getJobPaths(tempDir, started.jobId);
    const meta = JSON.parse(await fs.readFile(paths.meta, "utf8")) as typeof started;
    await fs.writeFile(paths.meta, `${JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 76_000).toISOString() })}\n`, "utf8");

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "stalled",
      parsedStdout: {
        result: expect.stringContaining("zero-progress assistant placeholder")
      }
    });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=plan mode=plan");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_stalled"');
    expect(trace).toContain('"stallReason":"provider_zero_progress"');
    expect(trace).toContain('"zeroProgressAssistantStallThresholdMs":45000');
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
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
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
    expect(trace).toContain('"stateInput":{"type":"object","preview":"{\\"filePath\\":\\"docs/VERIFICATION.md\\"}"}');
    expect(trace).toContain('input={\\"filePath\\":\\"docs/VERIFICATION.md\\"}');
  });

  it("classifies pending read tool calls with empty input as malformed provider tool calls", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1"
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

  it("preserves the source stall reason when a soft-stall rescue stalls in a read tool", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_BLANK_ASSISTANT_MS: "1",
        RETINUE_OPENCODE_STALL_READ_TOOL_MS: "1",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "1000"
      } as NodeJS.ProcessEnv
    });
    server!.setAutoAssistantResponses(false);
    const started = await backend.run({ cwd: tempDir, prompt: "review stalls blank after tool progress" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendBlankAssistant(started.externalSessionId!);

    await expect(backend.wait({ jobId: started.jobId }, 100)).resolves.toMatchObject({ status: "running" });
    await waitForPromptCount(2);
    server!.appendPendingReadToolAssistant(started.externalSessionId!);
    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "stalled" });
    const result = await backend.result({ jobId: started.jobId });
    expect(result.status).toBe("stalled");
    expect(result.stdout).toContain("pending/running read tool call");
    expect(result.stdout).toContain("rescueSource=provider_blank_assistant recovery=read_tool_stalled");
    expect(result.stdout).toContain("provider=litellm model=semantic-router agent=plan mode=plan");

    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"softStallRescueSourceReason":"provider_blank_assistant"');
    expect(trace).toContain('"recoveryStallReason":"read_tool_stalled"');
    const persisted = JSON.parse(await fs.readFile(getJobPaths(tempDir, started.jobId).meta, "utf8")) as typeof started;
    expect(persisted.externalSoftStallRescueSourceReason).toBe("provider_blank_assistant");
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
    expect(trace).not.toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
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
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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

  it("marks default no-final assistant tool rounds as stalled after the bounded tool-loop window", async () => {
    const backend = new OpenCodeBackend({
      client: new OpenCodeClient(server!.url),
      baseUrl: server!.url,
      stateDir: tempDir,
      env: {
        RETINUE_OPENCODE_STALL_TOOL_CALL_ROUNDS: "3",
        RETINUE_OPENCODE_SOFT_STALL_RESCUE_GRACE_MS: "0"
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
    setTimeout(() => {
      server!.completeSessionWithFinalText(started.externalSessionId!, "late wait result");
    }, 250);

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "late wait result" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_deferred"');
    expect(trace).toContain('"event":"opencode_job_status_changed"');
    expect(trace).toContain('"toStatus":"completed"');
  });

  it("submits a no-tools final-answer rescue prompt for recoverable OpenCode stalls", async () => {
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
    const started = await backend.run({ cwd: tempDir, prompt: "complex audit needs rescue" });
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source one");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source two");
    server!.appendToolCallAssistant(started.externalSessionId!, "checking source three");
    const completeAfterRescue = waitForPromptCount(2).then(() => {
      server!.completeSessionWithFinalText(started.externalSessionId!, "rescued final answer");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({ status: "completed" });
    await completeAfterRescue;
    expect(server!.promptRequests).toHaveLength(2);
    expect(extractPromptText(server!.promptRequests.at(-1))).toContain("Retinue recovery request");
    expect(server!.promptRequests.at(-1)).toMatchObject({
      agent: "build",
      tools: {
        read: false,
        grep: false,
        glob: false,
        bash: false,
        edit: false,
        write: false,
        patch: false,
        task: false
      }
    });
    await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
      status: "completed",
      parsedStdout: { result: "rescued final answer" }
    });
    const trace = await fs.readFile(getRetinueTracePath(tempDir), "utf8");
    expect(trace).toContain('"event":"opencode_job_soft_stall_rescue_submitted"');
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
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "apply_patch", pattern: "*", action: "deny" }
      ])
    });
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
