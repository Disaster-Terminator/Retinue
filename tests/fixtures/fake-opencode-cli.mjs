#!/usr/bin/env node
import http from "node:http";

const host = readArg("--hostname") ?? "127.0.0.1";
const port = Number(readArg("--port") ?? "0");
const sessions = new Map();
let nextSession = 1;
let nextMessage = 1;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method === "GET" && url.pathname === "/global/health") {
    writeJson(response, 200, { healthy: true, version: "fake-opencode-cli" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/session") {
    const body = await readJson(request);
    const session = {
      id: `ses_${nextSession++}`,
      title: typeof body.title === "string" ? body.title : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      state: "running",
      messages: []
    };
    sessions.set(session.id, session);
    writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd });
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
    writeJson(response, 200, { id: session.id, title: session.title, cwd: session.cwd, state: session.state });
    return;
  }

  if (request.method === "POST" && action === "prompt_async") {
    const body = await readJson(request);
    const prompt = Array.isArray(body.parts) ? String(body.parts[0]?.text ?? "") : "";
    session.messages.push({
      info: { id: `msg_${nextMessage++}`, sessionID: session.id, role: "user" },
      parts: [{ type: "text", text: prompt }]
    });
    session.messages.push({
      info: { id: `msg_${nextMessage++}`, sessionID: session.id, role: "assistant", time: { completed: Date.now() }, finish: "stop" },
      parts: [{ type: "text", text: `fake cli result: ${prompt}` }]
    });
    session.state = "completed";
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET" && action === "message") {
    writeJson(response, 200, session.messages);
    return;
  }

  if (request.method === "POST" && action === "abort") {
    session.state = "killed";
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 404, { error: { message: "Not found" } });
});

server.listen(port, host);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}
