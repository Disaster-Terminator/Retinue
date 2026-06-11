#!/usr/bin/env node
import process from "node:process";

const baseUrl = (process.env.RETINUE_OPENCODE_BASE_URL ?? "http://127.0.0.1:4097").replace(/\/+$/, "");
const cwd = process.env.RETINUE_OPENCODE_ROOT_BINDING_CWD ?? process.cwd();
const mode = process.env.RETINUE_OPENCODE_ROOT_BINDING_MODE ?? "both";
const timeoutMs = Number(process.env.RETINUE_OPENCODE_ROOT_BINDING_TIMEOUT_MS ?? 45_000);
const pollMs = 750;
const rootAgent = process.env.RETINUE_OPENCODE_ROOT_BINDING_ROOT_AGENT ?? "build";
const childAgent = process.env.RETINUE_OPENCODE_ROOT_BINDING_CHILD_AGENT ?? "explore";
const scenario = process.env.RETINUE_OPENCODE_ROOT_BINDING_SCENARIO ?? "deterministic";

const SCENARIOS = {
  deterministic: [
    {
      name: "one",
      marker: "RETINUE_ROOT_DETERMINISTIC_ONE_OK",
      prompt: "Do not use tools. Reply exactly: RETINUE_ROOT_DETERMINISTIC_ONE_OK"
    },
    {
      name: "two",
      marker: "RETINUE_ROOT_DETERMINISTIC_TWO_OK",
      prompt: "Do not use tools. Reply exactly: RETINUE_ROOT_DETERMINISTIC_TWO_OK"
    }
  ],
  "diff-bash": [
    {
      name: "diff-stat",
      marker: "RETINUE_ROOT_DIFF_STAT_DONE",
      prompt:
        "Do not modify files. Run git diff --stat once if bash is available, then report whether bash worked and end with RETINUE_ROOT_DIFF_STAT_DONE."
    },
    {
      name: "diff-name-status",
      marker: "RETINUE_ROOT_DIFF_NAME_STATUS_DONE",
      prompt:
        "Do not modify files. Run git diff --name-status once if bash is available, then report whether bash worked and end with RETINUE_ROOT_DIFF_NAME_STATUS_DONE."
    }
  ],
  "bounded-file-review": [
    {
      name: "package-review",
      marker: "RETINUE_ROOT_PACKAGE_REVIEW_DONE",
      prompt:
        "Read-only bounded review. Use at most 3 repository inspection tool calls. Inspect package.json only if needed. Judge whether package scripts include grouped test commands. Return PASS or FAIL with one evidence line and end with RETINUE_ROOT_PACKAGE_REVIEW_DONE."
    },
    {
      name: "mcp-review",
      marker: "RETINUE_ROOT_MCP_REVIEW_DONE",
      prompt:
        "Read-only bounded review. Use at most 3 repository inspection tool calls. Inspect src/mcp.ts only if needed. Judge whether spawn_agent exposes access_mode. Return PASS or FAIL with one evidence line and end with RETINUE_ROOT_MCP_REVIEW_DONE."
    }
  ],
  "write-intent-review": [
    {
      name: "useful-review-with-diff",
      marker: "RETINUE_ROOT_WRITE_INTENT_ONE_DONE",
      prompt:
        "Read-only review. Do not modify files. Inspect package.json if needed. Return one useful finding or PASS with evidence, then include a fenced diff snippet as an illustrative suggestion only. End with RETINUE_ROOT_WRITE_INTENT_ONE_DONE."
    },
    {
      name: "useful-review-with-patch-mention",
      marker: "RETINUE_ROOT_WRITE_INTENT_TWO_DONE",
      prompt:
        "Read-only review. Do not modify files. Inspect src/mcp.ts if needed. Return one useful finding or PASS with evidence, then include an apply_patch-style snippet as an illustrative suggestion only. End with RETINUE_ROOT_WRITE_INTENT_TWO_DONE."
    }
  ]
};

const createdSessions = [];

async function main() {
  const startedAt = new Date().toISOString();
  const health = await requestJson(
    "GET",
    "/global/health",
    undefined,
    "OpenCode server is unavailable. Start Retinue/OpenCode autoserve or set RETINUE_OPENCODE_BASE_URL."
  );
  const modes = selectModes(mode);
  const results = [];

  if (modes.includes("per-spawn")) {
    results.push(await probePerSpawn());
  }
  if (modes.includes("shared-root")) {
    results.push(await probeSharedRoot());
  }

  await cleanup();
  console.log(
    JSON.stringify(
      {
        ok: results.every((result) => result.ok),
        startedAt,
        finishedAt: new Date().toISOString(),
        baseUrl,
        cwd,
        mode,
        scenario,
        rootAgent,
        childAgent,
        health,
        results
      },
      null,
      2
    )
  );
}

function selectModes(value) {
  if (value === "both") {
    return ["per-spawn", "shared-root"];
  }
  if (value === "per-spawn" || value === "shared-root") {
    return [value];
  }
  throw new Error(`Unsupported RETINUE_OPENCODE_ROOT_BINDING_MODE: ${value}`);
}

async function probePerSpawn() {
  const tasks = selectScenario(scenario);
  const first = await createParentChild("retinue-root-binding-per-spawn-1", tasks[0]);
  const second = await createParentChild("retinue-root-binding-per-spawn-2", tasks[1]);
  const parentIds = [first.parent.id, second.parent.id];
  return {
    name: "per-spawn",
    runnerMode: "per-spawn",
    ok: parentIds[0] !== parentIds[1] && first.ok && second.ok,
    roots: parentIds,
    children: [first.child.id, second.child.id],
    childParentIds: [first.child.parentID, second.child.parentID],
    tasks: [first.taskSummary, second.taskSummary],
    childResults: [first.observed, second.observed],
    childrenByRoot: [first.childrenAfterPrompt, second.childrenAfterPrompt]
  };
}

async function probeSharedRoot() {
  const tasks = selectScenario(scenario);
  const root = await createSession({ title: "retinue-root-binding-shared-root", agent: rootAgent });
  const first = await createChildAndPrompt(root, "retinue-root-binding-shared-child-1", tasks[0]);
  const second = await createChildAndPrompt(root, "retinue-root-binding-shared-child-2", tasks[1]);
  const childrenAfterPrompt = await sessionChildren(root.id);
  const childIds = childrenAfterPrompt.map((session) => session.id);
  return {
    name: "shared-root",
    runnerMode: "shared-root",
    ok:
      first.ok &&
      second.ok &&
      first.child.parentID === root.id &&
      second.child.parentID === root.id &&
      childIds.includes(first.child.id) &&
      childIds.includes(second.child.id),
    root: root.id,
    children: [first.child.id, second.child.id],
    childParentIds: [first.child.parentID, second.child.parentID],
    tasks: [first.taskSummary, second.taskSummary],
    childResults: [first.observed, second.observed],
    childrenAfterPrompt
  };
}

function selectScenario(value) {
  const tasks = SCENARIOS[value];
  if (tasks) {
    return tasks;
  }
  throw new Error(`Unsupported RETINUE_OPENCODE_ROOT_BINDING_SCENARIO: ${value}`);
}

async function createParentChild(title, task) {
  const parent = await createSession({ title: `${title}-root`, agent: rootAgent });
  const childResult = await createChildAndPrompt(parent, `${title}-${task.name}-child`, task);
  const childrenAfterPrompt = await sessionChildren(parent.id);
  return {
    ok: childResult.ok && childResult.child.parentID === parent.id,
    parent,
    child: childResult.child,
    taskSummary: childResult.taskSummary,
    observed: childResult.observed,
    childrenAfterPrompt
  };
}

async function createChildAndPrompt(parent, title, task) {
  const child = await createSession({ title, parentID: parent.id, agent: childAgent });
  await promptAsync(child.id, {
    agent: childAgent,
    parts: [{ type: "text", text: task.prompt }]
  });
  const observed = await waitForFinalText(child.id);
  return {
    ok: observed.status === "completed" && observed.finalText.includes(task.marker),
    marker: task.marker,
    taskSummary: {
      name: task.name,
      marker: task.marker,
      status: observed.status,
      markerFound: (observed.finalText ?? "").includes(task.marker),
      finalTextBytes: Buffer.byteLength(observed.finalText ?? "", "utf8"),
      finalTextPreview: (observed.finalText ?? "").slice(0, 500)
    },
    child,
    observed
  };
}

async function createSession(body) {
  const session = await requestJson("POST", `/session?directory=${encodeURIComponent(cwd)}`, body);
  createdSessions.push(session.id);
  return session;
}

async function promptAsync(sessionID, body) {
  await requestVoid("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async?directory=${encodeURIComponent(cwd)}`, body);
}

async function sessionMessages(sessionID) {
  return requestJson("GET", `/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(cwd)}`);
}

async function sessionChildren(sessionID) {
  return requestJson("GET", `/session/${encodeURIComponent(sessionID)}/children?directory=${encodeURIComponent(cwd)}`);
}

async function waitForFinalText(sessionID) {
  const deadline = Date.now() + timeoutMs;
  let lastSummary;
  while (Date.now() < deadline) {
    const messages = await sessionMessages(sessionID);
    lastSummary = summarizeMessages(messages);
    const finalText = latestCompletedAssistantText(messages);
    if (finalText) {
      return { status: "completed", finalText, messageSummary: lastSummary };
    }
    await sleep(pollMs);
  }
  return { status: "timed_out", messageSummary: lastSummary };
}

function latestCompletedAssistantText(messages) {
  for (const message of [...messages].reverse()) {
    if (message?.info?.role !== "assistant") {
      continue;
    }
    const partTypes = Array.isArray(message.parts) ? message.parts.map((part) => part.type ?? "unknown") : [];
    if (partTypes.includes("tool")) {
      continue;
    }
    const text = extractText(message);
    const completed = message.info?.finish === "stop";
    if (completed && text.trim()) {
      return text.trim();
    }
  }
  return "";
}

function extractText(message) {
  return Array.isArray(message?.parts) ? message.parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("") : "";
}

function summarizeMessages(messages) {
  return {
    count: Array.isArray(messages) ? messages.length : 0,
    last: summarizeMessage(messages?.at?.(-1)),
    completedAssistantCount: Array.isArray(messages)
      ? messages.filter((message) => message?.info?.role === "assistant" && latestCompletedAssistantText([message])).length
      : 0
  };
}

function summarizeMessage(message) {
  if (!message) {
    return undefined;
  }
  return {
    role: message.info?.role,
    finish: message.info?.finish,
    agent: message.info?.agent,
    mode: message.info?.mode,
    providerID: message.info?.providerID,
    modelID: message.info?.modelID,
    partTypes: Array.isArray(message.parts) ? message.parts.map((part) => part.type ?? "unknown") : [],
    textBytes: Buffer.byteLength(extractText(message), "utf8")
  };
}

async function cleanup() {
  for (const sessionID of createdSessions.reverse()) {
    try {
      await requestJson("POST", `/session/${encodeURIComponent(sessionID)}/abort?directory=${encodeURIComponent(cwd)}`, {});
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function requestJson(method, path, body, connectionHint) {
  const response = await fetchWithHint(method, path, body, connectionHint);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text.trim() ? JSON.parse(text) : null;
}

async function requestVoid(method, path, body) {
  const response = await fetchWithHint(method, path, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function fetchWithHint(method, path, body, connectionHint) {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    if (connectionHint) {
      throw new Error(`${connectionHint} ${method} ${baseUrl}${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  await cleanup();
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
