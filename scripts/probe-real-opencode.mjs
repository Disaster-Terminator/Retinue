#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  requireOptIn();

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.SUPERVISOR_OPENCODE_BASE_URL ?? DEFAULT_BASE_URL);
  const sessionStatusPath = options.sessionStatusPath ?? process.env.SUPERVISOR_OPENCODE_SESSION_STATUS_PATH ?? null;

  const output = {
    ok: true,
    probe: "real-opencode",
    timestamp: new Date().toISOString(),
    baseUrl,
    steps: []
  };

  let sessionId = null;
  try {
    output.steps.push(await request("GET", `${baseUrl}/global/health`));

    const sessionCreate = await request("POST", `${baseUrl}/session`, { cwd: process.cwd() });
    output.steps.push(sessionCreate);
    sessionId = extractSessionId(sessionCreate.json);

    if (!sessionId) {
      throw new Error("Could not determine session id from POST /session response");
    }

    output.sessionId = sessionId;
    output.steps.push(await request("GET", `${baseUrl}/session/${encodeURIComponent(sessionId)}`));

    output.steps.push(
      await request("POST", `${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        prompt: "Reply exactly: SUPERVISOR_REAL_OPENCODE_OK"
      })
    );

    output.steps.push(await request("GET", `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`));

    if (sessionStatusPath) {
      const resolvedPath = sessionStatusPath.startsWith("/") ? sessionStatusPath : `/${sessionStatusPath}`;
      const resolved = resolvedPath.replace(":id", encodeURIComponent(sessionId));
      output.steps.push(await request("GET", `${baseUrl}${resolved}`));
    } else {
      output.steps.push({
        endpoint: "session status",
        skipped: true,
        reason: "No --session-status-path or SUPERVISOR_OPENCODE_SESSION_STATUS_PATH provided"
      });
    }

    output.steps.push(await request("POST", `${baseUrl}/session/${encodeURIComponent(sessionId)}/abort`));
  } catch (error) {
    output.ok = false;
    output.error = String(error?.message ?? error);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.ok ? 0 : 1;
}

function requireOptIn() {
  if (process.env.SUPERVISOR_REAL_OPENCODE_PROBE !== "1") {
    throw new Error("Manual probe opt-in required. Set SUPERVISOR_REAL_OPENCODE_PROBE=1.");
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      options.baseUrl = args[++index];
      continue;
    }
    if (arg === "--session-status-path") {
      options.sessionStatusPath = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  if (!isLoopbackHostname(hostname)) {
    throw new Error(`Only loopback OpenCode URLs are allowed. Received host: ${parsed.hostname}`);
  }

  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  if (hostname.startsWith("127.")) {
    return true;
  }

  return false;
}

function extractSessionId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.id === "string" && payload.id.length > 0) {
    return payload.id;
  }

  if (payload.session && typeof payload.session.id === "string" && payload.session.id.length > 0) {
    return payload.session.id;
  }

  return null;
}

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  const step = {
    endpoint: `${method} ${new URL(url).pathname}`,
    status: response.status,
    ok: response.ok
  };

  if (json !== null) {
    step.json = json;
  } else if (text) {
    step.text = text;
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${step.endpoint} with status ${response.status}`);
  }

  return step;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
