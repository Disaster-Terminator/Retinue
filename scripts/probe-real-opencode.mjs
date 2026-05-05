#!/usr/bin/env node

const OPT_IN_ENV = "SUPERVISOR_REAL_OPENCODE_PROBE";
const BASE_URL_ENV = "SUPERVISOR_OPENCODE_BASE_URL";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireOptIn();

  const baseUrl = resolveBaseUrl(args.baseUrl);
  assertLoopbackUrl(baseUrl);

  const startedAt = new Date().toISOString();
  const output = {
    ok: true,
    manualOnly: true,
    baseUrl,
    startedAt,
    operations: {}
  };

  const health = await requestJson(baseUrl, "GET", "/global/health");
  output.operations.health = summarizeResult(health);

  const created = await requestJson(baseUrl, "POST", "/session", {
    cwd: process.cwd(),
    title: "supervisor-real-opencode-probe"
  });
  output.operations.createSession = summarizeResult(created);

  const sessionId = created.data?.id;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("OpenCode /session response did not include a string id");
  }
  output.sessionId = sessionId;

  const session = await requestJson(baseUrl, "GET", `/session/${encodeURIComponent(sessionId)}`);
  output.operations.getSession = summarizeResult(session);

  const prompt = await requestJson(baseUrl, "POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    parts: [{ type: "text", text: "Reply exactly: SUPERVISOR_OPENCODE_REAL_OK" }]
  });
  output.operations.promptAsync = summarizeResult(prompt);

  const messages = await requestJson(baseUrl, "GET", `/session/${encodeURIComponent(sessionId)}/message`);
  output.operations.messages = summarizeResult(messages);

  output.operations.sessionStatus = await probeSessionStatus(baseUrl, sessionId);

  const abort = await requestJson(baseUrl, "POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
  output.operations.abort = summarizeResult(abort);

  output.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function probeSessionStatus(baseUrl, sessionId) {
  const candidates = [`/session/${encodeURIComponent(sessionId)}/status`, `/session/${encodeURIComponent(sessionId)}`];
  for (const path of candidates) {
    const result = await requestJson(baseUrl, "GET", path, undefined, { allow404: true, allowNonJson: true });
    if (result.status !== 404 && result.data !== undefined) {
      return { endpoint: path, ...summarizeResult(result) };
    }
  }
  return { ok: false, skipped: true, reason: "No JSON session status endpoint detected" };
}

function summarizeResult(result) {
  return {
    ok: result.ok,
    status: result.status,
    path: result.path,
    data: result.data
  };
}

async function requestJson(baseUrl, method, path, body, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
    });
  } catch (error) {
    throw new Error(`Transport error for ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  const data = parseJson(text);
  if (data === undefined) {
    if (options.allowNonJson) {
      return {
        ok: response.ok,
        status: response.status,
        path,
        data: undefined
      };
    }
    throw new Error(`Expected JSON response for ${method} ${path} but got: ${text.slice(0, 200)}`);
  }

  if (!response.ok && !(options.allow404 && response.status === 404)) {
    throw new Error(`Request failed for ${method} ${path} with status ${response.status}`);
  }

  return {
    ok: response.ok,
    status: response.status,
    path,
    data
  };
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const out = { baseUrl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === "--base-url" || token === "-u") && i + 1 < argv.length) {
      out.baseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function requireOptIn() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`Manual probe blocked. Set ${OPT_IN_ENV}=1 to run this script.`);
  }
}

function resolveBaseUrl(argBaseUrl) {
  const candidate = argBaseUrl ?? process.env[BASE_URL_ENV];
  if (!candidate) {
    throw new Error(`Missing OpenCode server URL. Provide --base-url or set ${BASE_URL_ENV}.`);
  }
  return candidate.replace(/\/+$/, "");
}

function assertLoopbackUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`Only http loopback URLs are allowed: ${rawUrl}`);
  }
  const host = parsed.hostname;
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!loopbackHosts.has(host)) {
    throw new Error(`Non-loopback URL rejected: ${rawUrl}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
