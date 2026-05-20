import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const scriptPath = path.resolve("scripts/probe-opencode-root-binding.mjs");
const execFileAsync = promisify(execFile);

interface SessionRecord {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  directory?: string;
  messages: unknown[];
}

describe("probe-opencode-root-binding", () => {
  it("compares per-spawn roots with a shared root at OpenCode API boundaries", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const sessions = new Map<string, SessionRecord>();
    let nextSession = 1;

    await withServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });

      if (req.method === "GET" && req.url === "/global/health") {
        return json(res, 200, { healthy: true, version: "test" });
      }

      if (req.method === "POST" && req.url?.startsWith("/session?")) {
        const id = `ses_${nextSession++}`;
        const bodyObject = isRecord(body) ? body : {};
        const session: SessionRecord = {
          id,
          title: typeof bodyObject.title === "string" ? bodyObject.title : undefined,
          parentID: typeof bodyObject.parentID === "string" ? bodyObject.parentID : undefined,
          agent: typeof bodyObject.agent === "string" ? bodyObject.agent : undefined,
          directory: "/tmp/root-binding-probe",
          messages: []
        };
        sessions.set(id, session);
        return json(res, 200, session);
      }

      const promptMatch = req.url?.match(/^\/session\/([^/]+)\/prompt_async\?/);
      if (req.method === "POST" && promptMatch) {
        const session = sessions.get(decodeURIComponent(promptMatch[1]));
        if (!session) return json(res, 404, { error: "missing session" });
        const promptText = isRecord(body) && Array.isArray(body.parts) ? body.parts.map((part) => (isRecord(part) ? part.text : "")).join("") : "";
        const expected = String(promptText).match(/RETINUE_ROOT_[A-Z_]+_OK/)?.[0] ?? "RETINUE_ROOT_UNKNOWN_OK";
        session.messages.push({
          info: { role: "assistant", finish: "stop", agent: session.agent, sessionID: session.id },
          parts: [{ type: "text", text: expected }]
        });
        res.writeHead(204);
        res.end();
        return;
      }

      const messageMatch = req.url?.match(/^\/session\/([^/]+)\/message\?/);
      if (req.method === "GET" && messageMatch) {
        return json(res, 200, sessions.get(decodeURIComponent(messageMatch[1]))?.messages ?? []);
      }

      const childrenMatch = req.url?.match(/^\/session\/([^/]+)\/children\?/);
      if (req.method === "GET" && childrenMatch) {
        const parentID = decodeURIComponent(childrenMatch[1]);
        return json(
          res,
          200,
          [...sessions.values()].filter((session) => session.parentID === parentID)
        );
      }

      const abortMatch = req.url?.match(/^\/session\/([^/]+)\/abort\?/);
      if (req.method === "POST" && abortMatch) {
        return json(res, 200, { ok: true });
      }

      return json(res, 500, { error: `unexpected ${req.method} ${req.url}` });
    }, async (baseUrl) => {
      const result = await execFileAsync(process.execPath, [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          RETINUE_OPENCODE_BASE_URL: baseUrl,
          RETINUE_OPENCODE_ROOT_BINDING_CWD: "/tmp/root-binding-probe",
          RETINUE_OPENCODE_ROOT_BINDING_MODE: "both",
          RETINUE_OPENCODE_ROOT_BINDING_TIMEOUT_MS: "1000"
        }
      });
      const output = JSON.parse(result.stdout);
      const perSpawn = output.results.find((item: { name: string }) => item.name === "per-spawn");
      const sharedRoot = output.results.find((item: { name: string }) => item.name === "shared-root");

      expect(output.ok).toBe(true);
      expect(perSpawn).toMatchObject({ ok: true });
      expect(new Set(perSpawn.roots).size).toBe(2);
      expect(sharedRoot).toMatchObject({ ok: true });
      expect(new Set(sharedRoot.childParentIds)).toEqual(new Set([sharedRoot.root]));
      expect(sharedRoot.childrenAfterPrompt.map((session: { id: string }) => session.id)).toEqual(expect.arrayContaining(sharedRoot.children));
    });

    const createRequests = requests.filter((request) => request.method === "POST" && request.url.startsWith("/session?"));
    expect(createRequests.length).toBe(7);
  });
});

async function withServer(handler: http.RequestListener, run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address missing");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
