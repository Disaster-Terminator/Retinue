import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSdkBackend } from "../src/backends/claude/sdkBackend.js";

describe("ClaudeCodeSdkBackend", () => {
  it("stores Claude Agent SDK result output in Retinue job artifacts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-claude-sdk-result-"));
    try {
      const backend = new ClaudeCodeSdkBackend({
        stateDir: tempDir,
        query: async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "RETINUE_SDK_BACKEND_OK",
            session_id: "sdk-session-1"
          };
        }
      });

      const started = await backend.run({ cwd: tempDir, prompt: "reply", name: "sdk-smoke" });
      expect(started).toMatchObject({
        backend: "claude-code",
        status: "running",
        pid: -1,
        name: "sdk-smoke"
      });

      await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
        jobId: started.jobId,
        status: "completed"
      });
      await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
        jobId: started.jobId,
        status: "completed",
        sessionId: "sdk-session-1",
        parsedStdout: { result: "RETINUE_SDK_BACKEND_OK", session_id: "sdk-session-1" }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves the Claude SDK model unset unless deployment explicitly overrides it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-claude-sdk-model-"));
    const seenModels: unknown[] = [];
    try {
      const backend = new ClaudeCodeSdkBackend({
        stateDir: tempDir,
        env: {},
        query: async function* ({ options }) {
          expect(Object.prototype.hasOwnProperty.call(options ?? {}, "model")).toBe(false);
          seenModels.push(options?.model);
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "model-default",
            session_id: "sdk-session-model-default"
          };
        }
      });
      const started = await backend.run({ cwd: tempDir, prompt: "model default" });
      await backend.wait({ jobId: started.jobId }, 1000);
      expect(seenModels).toEqual([undefined]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes the Claude SDK model only from explicit deployment configuration", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-claude-sdk-model-override-"));
    const seenModels: unknown[] = [];
    try {
      const backend = new ClaudeCodeSdkBackend({
        stateDir: tempDir,
        env: { RETINUE_CLAUDE_MODEL: "claude-sonnet-test" },
        query: async function* ({ options }) {
          seenModels.push(options?.model);
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "model-explicit",
            session_id: "sdk-session-model-explicit"
          };
        }
      });
      const started = await backend.run({ cwd: tempDir, prompt: "model explicit" });
      await backend.wait({ jobId: started.jobId }, 1000);
      expect(seenModels).toEqual(["claude-sonnet-test"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces canUseTool requests through the Retinue permission bridge and resumes on reply", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-claude-sdk-permission-"));
    try {
      const backend = new ClaudeCodeSdkBackend({
        stateDir: tempDir,
        query: async function* ({ options }) {
          const permission = await options?.canUseTool?.(
            "Read",
            { file_path: "/etc/hostname" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-read-1",
              displayName: "Read",
              description: "/etc/hostname",
              decisionReason: "Path is outside allowed working directories",
              suggestions: []
            }
          );
          expect((permission as typeof permission & { updatedInput?: unknown })?.updatedInput).toEqual({ file_path: "/etc/hostname" });
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: `permission:${permission?.behavior}`,
            session_id: "sdk-session-permission"
          };
        }
      });

      const started = await backend.run({ cwd: tempDir, prompt: "read external path", name: "sdk-permission" });
      const pending = await backend.wait({ jobId: started.jobId }, 1000);
      expect(pending).toMatchObject({
        jobId: started.jobId,
        status: "running",
        permissionRequired: true,
        permissions: [
          {
            id: "tool-read-1",
            permission: "Read",
            patterns: ["/etc/hostname"],
            approval: {
              kind: "claude_code_permission",
              title: "Read"
            }
          }
        ]
      });

      await expect(backend.listPermissions({ jobId: started.jobId })).resolves.toMatchObject({
        jobId: started.jobId,
        backend: "claude-code",
        status: "running",
        permissions: [{ id: "tool-read-1", permission: "Read" }]
      });
      await expect(backend.replyPermission({ jobId: started.jobId }, { requestId: "tool-read-1", reply: "once" })).resolves.toMatchObject({
        repliedRequestId: "tool-read-1",
        reply: "once",
        permissions: []
      });
      await expect(backend.wait({ jobId: started.jobId }, 1000)).resolves.toMatchObject({
        jobId: started.jobId,
        status: "completed"
      });
      await expect(backend.result({ jobId: started.jobId })).resolves.toMatchObject({
        parsedStdout: { result: "permission:allow" }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
