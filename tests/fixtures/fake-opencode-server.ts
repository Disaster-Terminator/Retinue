import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeSession {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
  directory?: string;
  cwd?: string;
  aborted?: boolean;
  state: "running" | "completed" | "failed";
  omitState?: boolean;
  failureReason?: string;
  messages: Array<{
    info: { id: string; sessionID: string; role: string; time?: { completed?: number }; finish?: string; error?: unknown };
    parts: Array<{ type: string; text?: string; tool?: string; callID?: string; state?: Record<string, unknown> }>;
  }>;
}

interface FakePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: {
    messageID?: string;
    callID?: string;
  };
}

export interface FakeOpenCodeServer {
  url: string;
  sessionRequests: Array<Record<string, unknown>>;
  promptRequests: Array<Record<string, unknown>>;
  setAutoAssistantResponses(enabled: boolean): void;
  setPromptAsyncDelayMs(ms: number): void;
  setPromptAsyncFailure(status: number, body: unknown): void;
  setSessionPermission(
    sessionId: string,
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  ): void;
  completeSession(sessionId: string): void;
  completeSessionByMessageOnly(sessionId: string): void;
  completeSessionWithFinalText(sessionId: string, text: string): void;
  completeSessionWithToolCallTextOnly(sessionId: string): void;
  appendToolCallAssistant(sessionId: string, text?: string): void;
  appendWriteIntentAssistant(sessionId: string, tool: "write" | "edit" | "apply_patch", text?: string): void;
  appendRunningReadToolAssistant(sessionId: string): void;
  appendPendingReadToolAssistant(sessionId: string): void;
  appendFailedToolCallAssistant(sessionId: string): void;
  appendExternalDirectoryPermission(sessionId: string, filePath: string, callID?: string): void;
  appendMalformedReadToolAssistant(sessionId: string): void;
  appendMalformedToolAssistant(sessionId: string, tool: string): void;
  appendEmptyTextAssistant(sessionId: string): void;
  appendBlankAssistant(sessionId: string): void;
  appendZeroProgressReasoningAssistant(sessionId: string): void;
  appendZeroProgressFinishedAssistant(sessionId: string): void;
  appendReasoningOnlyIncompleteAssistant(sessionId: string, text: string): void;
  appendIncompleteAssistant(sessionId: string, text?: string): void;
  appendPatchAssistant(sessionId: string, text?: string): void;
  appendErroredPatchAssistant(sessionId: string, error: unknown): void;
  appendErroredIncompleteAssistant(sessionId: string, error: unknown): void;
  completeSessionWithReasoningOnly(sessionId: string): void;
  failSession(sessionId: string, reason?: string): void;
  close(): Promise<void>;
}

export async function startFakeOpenCodeServer(options: { serverCwd?: string } = {}): Promise<FakeOpenCodeServer> {
  const sessions = new Map<string, FakeSession>();
  const pendingPermissions: FakePermissionRequest[] = [];
  const sessionRequests: Array<Record<string, unknown>> = [];
  const promptRequests: Array<Record<string, unknown>> = [];
  const serverCwd = options.serverCwd ?? process.cwd();
  let autoAssistantResponses = true;
  let promptAsyncDelayMs = 0;
  let promptAsyncFailure: { status: number; body: unknown } | undefined;
  let nextSession = 1;
  let nextMessage = 1;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (request.method === "GET" && url.pathname === "/global/health") {
      writeJson(response, 200, { status: "ok", service: "fake-opencode" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/agent") {
      writeJson(response, 200, [
        {
          name: "build",
          mode: "primary",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "edit", pattern: "blocked-by-plan", action: "deny" }
          ]
        },
        {
          name: "explore",
          mode: "subagent",
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "read", pattern: "*", action: "allow" },
            { permission: "glob", pattern: "*", action: "allow" },
            { permission: "grep", pattern: "*", action: "allow" }
          ]
        },
        {
          name: "general",
          mode: "subagent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }]
        },
        {
          name: "plan",
          mode: "primary",
          permission: [{ permission: "*", pattern: "*", action: "allow" }]
        }
      ]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/permission") {
      writeJson(response, 200, pendingPermissions);
      return;
    }

    const permissionReplyMatch = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
    if (request.method === "POST" && permissionReplyMatch) {
      await readJson(request);
      const requestId = decodeURIComponent(permissionReplyMatch[1]);
      const index = pendingPermissions.findIndex((permission) => permission.id === requestId);
      if (index < 0) {
        writeJson(response, 404, { error: { message: "Missing permission request" } });
        return;
      }
      const [permission] = pendingPermissions.splice(index, 1);
      const permissionSession = sessions.get(permission.sessionID);
      let updatedToolState = false;
      for (const message of permissionSession?.messages ?? []) {
        for (const part of message.parts) {
          if (part.type !== "tool" || !part.state || (part.state.status !== "pending" && part.state.status !== "running")) {
            continue;
          }
          if (permission.tool?.callID && part.callID !== permission.tool.callID) {
            continue;
          }
          part.state.status = "error";
          updatedToolState = true;
        }
      }
      if (!updatedToolState) {
        for (const message of permissionSession?.messages ?? []) {
          for (const part of message.parts) {
            if (part.type === "tool" && part.state && (part.state.status === "pending" || part.state.status === "running")) {
              part.state.status = "error";
            }
          }
        }
      }
      writeJson(response, 200, true);
      return;
    }

    if (request.method === "POST" && url.pathname === "/session") {
      const body = await readJson(request);
      const requestedDirectory = url.searchParams.get("directory") ?? (typeof body.directory === "string" ? body.directory : undefined);
      sessionRequests.push({ ...body, directory: requestedDirectory });
      const session: FakeSession = {
        id: `ses_${nextSession++}`,
        title: typeof body.title === "string" ? body.title : undefined,
        parentID: typeof body.parentID === "string" ? body.parentID : undefined,
        agent: typeof body.agent === "string" ? body.agent : undefined,
        permission: Array.isArray(body.permission) ? body.permission : undefined,
        directory: serverCwd,
        state: "running",
        messages: []
      };
      sessions.set(session.id, session);
      writeJson(response, 200, {
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
        permission: session.permission,
        directory: session.directory,
        cwd: session.cwd
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/session") {
      writeJson(
        response,
        200,
        [...sessions.values()].map((session) => ({
          id: session.id,
          title: session.title,
          parentID: session.parentID,
          agent: session.agent,
          permission: session.permission,
          directory: session.directory,
          cwd: session.cwd
        }))
      );
      return;
    }

    const sessionMatch = /^\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!sessionMatch) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    const session = sessions.get(decodeURIComponent(sessionMatch[1]));
    if (!session) {
      writeJson(response, 404, { error: { message: "Missing session" } });
      return;
    }

    const action = sessionMatch[2];
    if (request.method === "GET" && !action) {
      writeJson(response, 200, {
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
        permission: session.permission,
        directory: session.directory,
        cwd: session.cwd,
        aborted: session.aborted === true,
        state: session.omitState ? undefined : session.state,
        failureReason: session.failureReason
      });
      return;
    }

    if (request.method === "POST" && action === "prompt_async") {
      if (promptAsyncDelayMs > 0) {
        await sleep(promptAsyncDelayMs);
      }
      if (promptAsyncFailure) {
        writeJson(response, promptAsyncFailure.status, promptAsyncFailure.body);
        return;
      }
      const body = await readJson(request);
      promptRequests.push(body);
      const subtaskPart = Array.isArray(body.parts)
        ? body.parts.find(
            (part): part is { type: string; description?: string; agent?: string; prompt?: string } =>
              typeof part === "object" && part !== null && (part as { type?: unknown }).type === "subtask"
          )
        : undefined;
      if (subtaskPart) {
        const childId = `ses_${nextSession++}`;
        const child: FakeSession = {
          id: childId,
          title: subtaskPart.description ? `${subtaskPart.description} (@${subtaskPart.agent ?? "agent"} subagent)` : undefined,
          parentID: session.id,
          agent: subtaskPart.agent,
          directory: session.directory,
          state: "completed",
          messages: [
            {
              info: { id: `msg_${nextMessage++}`, sessionID: childId, role: "assistant", time: { completed: Date.now() }, finish: "stop" },
              parts: [{ type: "text", text: subtaskPart.prompt ?? "" }]
            }
          ]
        };
        sessions.set(child.id, child);
      }
      const prompt =
        Array.isArray(body.parts) && typeof body.parts[0] === "object" && body.parts[0] !== null && "text" in body.parts[0]
          ? String((body.parts[0] as { text?: unknown }).text ?? "")
          : "";
      const messageId = `msg_${nextMessage++}`;
      session.messages.push({
        info: { id: messageId, sessionID: session.id, role: "user" },
        parts: [{ type: "text", text: prompt }]
      });
      if (autoAssistantResponses) {
        const assistantMessageId = `msg_${nextMessage++}`;
        session.messages.push({
          info: { id: assistantMessageId, sessionID: session.id, role: "assistant" },
          parts: [{ type: "text", text: `fake result: ${prompt}` }]
        });
      }
      session.state = "running";
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && action === "message") {
      writeJson(response, 200, session.messages);
      return;
    }

    if (request.method === "GET" && action === "children") {
      writeJson(
        response,
        200,
        [...sessions.values()]
          .filter((candidate) => candidate.parentID === session.id)
          .map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            parentID: candidate.parentID,
            agent: candidate.agent,
            permission: candidate.permission,
            directory: candidate.directory,
            cwd: candidate.cwd
          }))
      );
      return;
    }

    if (request.method === "POST" && action === "abort") {
      session.aborted = true;
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 404, { error: { message: "Not found" } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    sessionRequests,
    promptRequests,
    setAutoAssistantResponses: (enabled: boolean) => {
      autoAssistantResponses = enabled;
    },
    setPromptAsyncDelayMs: (ms: number) => {
      promptAsyncDelayMs = ms;
    },
    setPromptAsyncFailure: (status: number, body: unknown) => {
      promptAsyncFailure = { status, body };
    },
    setSessionPermission: (
      sessionId: string,
      permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
    ) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.permission = permission;
      }
    },
    completeSession: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.state = "completed";
      }
    },
    completeSessionByMessageOnly: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        const last = session.messages.at(-1);
        if (last) {
          last.info.time = { completed: Date.now() };
          last.info.finish = "stop";
        }
      }
    },
    completeSessionWithFinalText: (sessionId: string, text: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: { id: `msg_${nextMessage++}`, sessionID: session.id, role: "assistant", time: { completed: Date.now() }, finish: "stop" },
          parts: [{ type: "text", text }]
        });
      }
    },
    completeSessionWithToolCallTextOnly: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "tool-calls"
          },
          parts: [
            { type: "step-start" },
            { type: "text", text: "Let me gather more data before the final answer." },
            { type: "tool", text: "tool call placeholder", tool: "task", callID: `call_${nextMessage}`, state: { status: "completed" } },
            { type: "step-finish" }
          ]
        });
      }
    },
    appendToolCallAssistant: (sessionId: string, text = "") => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "tool-calls"
          },
          parts: [
            { type: "step-start" },
            ...(text ? [{ type: "text", text }] : []),
            { type: "tool", text: "tool call placeholder", tool: "task", callID: `call_${nextMessage}`, state: { status: "completed" } },
            { type: "step-finish" }
          ]
        });
      }
    },
    appendWriteIntentAssistant: (sessionId: string, tool: "write" | "edit" | "apply_patch", text = "") => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "tool-calls"
          },
          parts: [
            { type: "step-start" },
            ...(text ? [{ type: "text", text }] : []),
            { type: "tool", text: `${tool} placeholder`, tool, callID: `call_${nextMessage}`, state: { status: "pending" } },
            { type: "step-finish" }
          ]
        });
      }
    },
    appendRunningReadToolAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "plan",
            mode: "plan"
          },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "Need to inspect a few files." },
            {
              type: "tool",
              text: "read placeholder",
              tool: "read",
              callID: `call_${nextMessage}`,
              state: { status: "running", input: { filePath: "src/backends/opencode/backend.ts" } }
            },
            {
              type: "tool",
              text: "read placeholder",
              tool: "read",
              callID: `call_${nextMessage + 1}`,
              state: { status: "error", input: { filePath: "src/backends/opencode/client.ts" } }
            }
          ]
        });
      }
    },
    appendPendingReadToolAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "plan",
            mode: "plan"
          },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "Need to inspect one more file." },
            {
              type: "tool",
              text: "read placeholder",
              tool: "read",
              callID: `call_${nextMessage}`,
              state: { status: "pending", input: { filePath: "docs/how-to/verify.md" } }
            }
          ]
        });
      }
    },
    appendFailedToolCallAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            finish: "tool-calls",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "explore",
            mode: "explore"
          },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "The requested external path was rejected." },
            {
              type: "tool",
              text: "read placeholder",
              tool: "read",
              callID: `call_${nextMessage}`,
              state: { status: "error", input: { filePath: "/home/raystudio/projects/Retinue/src/backends/opencode/backend.ts" } }
            },
            { type: "step-finish" },
            { type: "patch" }
          ]
        });
      }
    },
    appendExternalDirectoryPermission: (sessionId: string, filePath: string, callID = "call_external_read") => {
      pendingPermissions.push({
        id: `per_${pendingPermissions.length + 1}`,
        sessionID: sessionId,
        permission: "external_directory",
        patterns: [filePath],
        always: [filePath],
        metadata: { filepath: filePath, parentDir: filePath.replace(/\/[^/]*$/, "") },
        tool: { messageID: `msg_${nextMessage}`, callID }
      });
    },
    appendMalformedReadToolAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "explore",
            mode: "explore"
          },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "Need to inspect a file but emitted malformed read input." },
            {
              type: "tool",
              text: "read placeholder",
              tool: "read",
              callID: `call_${nextMessage}`,
              state: { status: "pending", input: {} }
            }
          ]
        });
      }
    },
    appendMalformedToolAssistant: (sessionId: string, tool: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "explore",
            mode: "explore"
          },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: `Need to use ${tool} but emitted malformed input.` },
            {
              type: "tool",
              text: `${tool} placeholder`,
              tool,
              callID: `call_${nextMessage}`,
              state: { status: "pending", input: {} }
            }
          ]
        });
      }
    },
    appendEmptyTextAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "explore",
            mode: "explore",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: [{ type: "step-start" }, { type: "text", text: "" }]
        });
      }
    },
    appendBlankAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "plan",
            mode: "plan",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: []
        });
      }
    },
    appendZeroProgressReasoningAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "plan",
            mode: "plan",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "" }]
        });
      }
    },
    appendZeroProgressFinishedAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            finish: "unknown",
            providerID: "litellm-cloud",
            modelID: "deep",
            agent: "explore",
            mode: "explore",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: [{ type: "step-start" }, { type: "step-finish" }]
        });
      }
    },
    appendReasoningOnlyIncompleteAssistant: (sessionId: string, text: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm-cloud",
            modelID: "deep",
            agent: "explore",
            mode: "explore",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          },
          parts: [{ type: "step-start" }, { type: "reasoning", text }, { type: "text", text: "" }]
        });
      }
    },
    appendPatchAssistant: (sessionId: string, text = "") => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "tool-calls"
          },
          parts: [
            { type: "step-start" },
            ...(text ? [{ type: "text", text }] : []),
            { type: "tool", text: "tool call placeholder", tool: "task", callID: `call_${nextMessage}`, state: { status: "completed" } },
            { type: "patch", text: "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch\n" },
            { type: "step-finish" }
          ]
        });
      }
    },
    appendErroredPatchAssistant: (sessionId: string, error: unknown) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            providerID: "litellm",
            modelID: "semantic-router",
            agent: "plan",
            mode: "plan",
            error
          },
          parts: [{ type: "patch", text: "" }]
        });
      }
    },
    appendErroredIncompleteAssistant: (sessionId: string, error: unknown) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            error
          },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "tool call failed before final answer" }]
        });
      }
    },
    appendEmptyStopAssistant: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant",
            time: { completed: Date.now() },
            finish: "stop"
          },
          parts: [{ type: "step-start" }, { type: "step-finish" }]
        });
      }
    },
    appendIncompleteAssistant: (sessionId: string, text = "") => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: {
            id: `msg_${nextMessage++}`,
            sessionID: session.id,
            role: "assistant"
          },
          parts: [
            { type: "step-start" },
            ...(text ? [{ type: "text", text }] : []),
            { type: "tool", text: "tool call placeholder", tool: "task", callID: `call_${nextMessage}`, state: { status: "running" } }
          ]
        });
      }
    },
    completeSessionWithReasoningOnly: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.omitState = true;
        session.messages.push({
          info: { id: `msg_${nextMessage++}`, sessionID: session.id, role: "assistant", time: { completed: Date.now() }, finish: "stop" },
          parts: [{ type: "step-start" }, { type: "reasoning", text: "internal reasoning only" }, { type: "step-finish" }]
        });
      }
    },
    failSession: (sessionId: string, reason?: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.state = "failed";
        session.failureReason = reason;
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
