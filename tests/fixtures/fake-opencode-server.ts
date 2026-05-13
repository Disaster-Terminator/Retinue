import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeSession {
  id: string;
  title?: string;
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

export interface FakeOpenCodeServer {
  url: string;
  sessionRequests: Array<Record<string, unknown>>;
  promptRequests: Array<Record<string, unknown>>;
  setAutoAssistantResponses(enabled: boolean): void;
  setPromptAsyncDelayMs(ms: number): void;
  setPromptAsyncFailure(status: number, body: unknown): void;
  completeSession(sessionId: string): void;
  completeSessionByMessageOnly(sessionId: string): void;
  completeSessionWithFinalText(sessionId: string, text: string): void;
  completeSessionWithToolCallTextOnly(sessionId: string): void;
  appendToolCallAssistant(sessionId: string, text?: string): void;
  appendPatchAssistant(sessionId: string): void;
  appendErroredIncompleteAssistant(sessionId: string, error: unknown): void;
  completeSessionWithReasoningOnly(sessionId: string): void;
  failSession(sessionId: string, reason?: string): void;
  close(): Promise<void>;
}

export async function startFakeOpenCodeServer(options: { serverCwd?: string } = {}): Promise<FakeOpenCodeServer> {
  const sessions = new Map<string, FakeSession>();
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

    if (request.method === "POST" && url.pathname === "/session") {
      const body = await readJson(request);
      sessionRequests.push(body);
      const session: FakeSession = {
        id: `ses_${nextSession++}`,
        title: typeof body.title === "string" ? body.title : undefined,
        directory: serverCwd,
        state: "running",
        messages: []
      };
      sessions.set(session.id, session);
      writeJson(response, 200, { id: session.id, title: session.title, directory: session.directory, cwd: session.cwd });
      return;
    }

    if (request.method === "GET" && url.pathname === "/session") {
      writeJson(
        response,
        200,
        [...sessions.values()].map((session) => ({ id: session.id, title: session.title, directory: session.directory, cwd: session.cwd }))
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
    appendPatchAssistant: (sessionId: string) => {
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
            { type: "tool", text: "tool call placeholder", tool: "task", callID: `call_${nextMessage}`, state: { status: "completed" } },
            { type: "patch", text: "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch\n" },
            { type: "step-finish" }
          ]
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
          parts: [{ type: "reasoning", text: "internal reasoning only" }]
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
