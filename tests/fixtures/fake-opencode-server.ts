import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeSession {
  id: string;
  title?: string;
  cwd?: string;
  aborted?: boolean;
  messages: Array<{ info: { id: string; sessionID: string; role: string }; parts: Array<{ type: string; text: string }> }>;
}

export interface FakeOpenCodeServer {
  url: string;
  close(): Promise<void>;
}

export async function startFakeOpenCodeServer(): Promise<FakeOpenCodeServer> {
  const sessions = new Map<string, FakeSession>();
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
      const session: FakeSession = {
        id: `ses_${nextSession++}`,
        title: typeof body.title === "string" ? body.title : undefined,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        messages: []
      };
      sessions.set(session.id, session);
      writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd });
      return;
    }

    if (request.method === "GET" && url.pathname === "/session") {
      writeJson(
        response,
        200,
        [...sessions.values()].map((session) => ({ id: session.id, title: session.title, cwd: session.cwd }))
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
      writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd, aborted: session.aborted === true });
      return;
    }

    if (request.method === "POST" && action === "prompt_async") {
      const body = await readJson(request);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      const promptPart = parts.find((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") as
        | { text?: unknown }
        | undefined;
      const prompt = typeof promptPart?.text === "string" ? promptPart.text : "";
      const messageId = `msg_${nextMessage++}`;
      session.messages.push({
        info: { id: messageId, sessionID: session.id, role: "assistant" },
        parts: [{ type: "text", text: `fake result: ${prompt}` }]
      });
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
