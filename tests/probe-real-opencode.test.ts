import { describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const scriptPath = path.resolve("scripts/probe-real-opencode.mjs");
const execFileAsync = promisify(execFile);

function runProbeSync(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

async function runProbeAsync(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

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

function parseStderr(stderr: string) {
  try { return JSON.parse(stderr); } catch { return null; }
}

describe("probe-real-opencode", () => {
  it("rejects missing opt-in", () => {
    const result = runProbeSync(["--base-url", "http://127.0.0.1:1"], { RETINUE_REAL_OPENCODE_PROBE: "0" });
    expect(result.status).toBe(1);
    expect(parseStderr(result.stderr)?.error).toContain("RETINUE_REAL_OPENCODE_PROBE=1");
  });

  it("rejects non-loopback URL", () => {
    const result = runProbeSync(["--base-url", "http://example.com:1234"], { RETINUE_REAL_OPENCODE_PROBE: "1" });
    expect(result.status).toBe(1);
    expect(parseStderr(result.stderr)?.error).toContain("Non-loopback URL rejected");
  });

  it("sends structured parts to prompt_async and accepts 204", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    await withServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", body: text ? JSON.parse(text) : null });

      if (req.method === "GET" && req.url === "/global/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.url === "/session") return json(res, 200, { id: "s1" });
      if (req.method === "GET" && req.url === "/session/s1") return json(res, 200, { id: "s1" });
      if (req.method === "POST" && req.url === "/session/s1/prompt_async") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && req.url === "/session/s1/message") return json(res, 200, []);
      if (req.method === "GET" && req.url === "/session/s1/status") return json(res, 404, { error: "not found" });
      if (req.method === "POST" && req.url === "/session/s1/abort") return json(res, 200, { ok: true });
      return json(res, 500, { error: `unexpected ${req.method} ${req.url}` });
    }, async (baseUrl) => {
      const result = await runProbeAsync(["--base-url", baseUrl], { RETINUE_REAL_OPENCODE_PROBE: "1" });
      const output = JSON.parse(result.stdout);
      expect(output.operations.promptAsync.status).toBe(204);
    });

    const promptReq = requests.find((r) => r.method === "POST" && r.url === "/session/s1/prompt_async");
    expect(promptReq?.body).toEqual({ parts: [{ type: "text", text: "Reply exactly: RETINUE_OPENCODE_REAL_OK" }] });
  });

  it("falls back to session details when status endpoint returns HTML", async () => {
    await withServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/global/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.url === "/session") return json(res, 200, { id: "s1" });
      if (req.method === "GET" && req.url === "/session/s1") return json(res, 200, { id: "s1", state: "running" });
      if (req.method === "POST" && req.url === "/session/s1/prompt_async") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && req.url === "/session/s1/message") return json(res, 200, []);
      if (req.method === "GET" && req.url === "/session/s1/status") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html></html>");
        return;
      }
      if (req.method === "POST" && req.url === "/session/s1/abort") return json(res, 200, { ok: true });
      return json(res, 500, { error: `unexpected ${req.method} ${req.url}` });
    }, async (baseUrl) => {
      const result = await runProbeAsync(["--base-url", baseUrl], { RETINUE_REAL_OPENCODE_PROBE: "1" });
      const output = JSON.parse(result.stdout);
      expect(output.operations.sessionStatus).toMatchObject({
        ok: true,
        endpoint: "/session/s1",
        data: { id: "s1", state: "running" }
      });
    });
  });
});

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
