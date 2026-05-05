import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeSession {
  id: string;
  title?: string;
  cwd?: string;
  state: "running" | "completed" | "failed";
  aborted?: boolean;
  messages: Array<{ info: { id: string; sessionID: string; role: string }; parts: Array<{ type: "text"; text: string }> }>;
}

export interface FakeOpenCodeServer { url: string; close(): Promise<void>; completeSession(sessionId: string): void; failSession(sessionId: string): void; }

export async function startFakeOpenCodeServer(): Promise<FakeOpenCodeServer> {
  const sessions = new Map<string, FakeSession>();
  let nextSession = 1;
  let nextMessage = 1;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/global/health") return writeJson(response, 200, { status: "ok", service: "fake-opencode" });
    if (request.method === "POST" && url.pathname === "/session") {
      const body = await readJson(request);
      const session: FakeSession = { id: `ses_${nextSession++}`, title: typeof body.title === "string" ? body.title : undefined, cwd: typeof body.cwd === "string" ? body.cwd : undefined, state: "running", messages: [] };
      sessions.set(session.id, session); return writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd, state: session.state }); }
    if (request.method === "GET" && url.pathname === "/session") return writeJson(response, 200, [...sessions.values()].map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, state: s.state, aborted: s.aborted === true })));
    const sessionMatch = /^\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname); if (!sessionMatch) return writeJson(response, 404, { error: { message: "Not found" } });
    const session = sessions.get(decodeURIComponent(sessionMatch[1])); if (!session) return writeJson(response, 404, { error: { message: "Missing session" } });
    const action = sessionMatch[2];
    if (request.method === "GET" && !action) return writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd, aborted: session.aborted === true, state: session.state });
    if (request.method === "POST" && action === "prompt_async") { const body = await readJson(request); const prompt = Array.isArray(body.parts) && typeof body.parts[0] === "object" && body.parts[0] !== null && "text" in body.parts[0] ? String((body.parts[0] as { text?: unknown }).text ?? "") : ""; session.messages.push({ info: { id: `msg_${nextMessage++}`, sessionID: session.id, role: "assistant" }, parts: [{ type: "text", text: `fake result: ${prompt}` }] }); session.state = "running"; response.statusCode = 204; return response.end(); }
    if (request.method === "GET" && action === "message") return writeJson(response, 200, session.messages);
    if (request.method === "POST" && action === "abort") { session.aborted = true; return writeJson(response, 200, { ok: true }); }
    writeJson(response, 404, { error: { message: "Not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), completeSession: (id) => { const s = sessions.get(id); if (s && !s.aborted) s.state = "completed"; }, failSession: (id) => { const s = sessions.get(id); if (s && !s.aborted) s.state = "failed"; } };
}
function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void { response.statusCode = statusCode; response.end(JSON.stringify(body)); }
async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); const text = Buffer.concat(chunks).toString("utf8"); return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}; }
