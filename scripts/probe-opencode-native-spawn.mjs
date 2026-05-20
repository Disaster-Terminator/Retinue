#!/usr/bin/env node
import process from "node:process";

const baseUrl = (process.env.RETINUE_OPENCODE_BASE_URL ?? "http://127.0.0.1:4097").replace(/\/+$/, "");
const cwd = process.env.RETINUE_NATIVE_SPAWN_PROBE_CWD ?? process.cwd();
const timeoutMs = Number(process.env.RETINUE_NATIVE_SPAWN_PROBE_TIMEOUT_MS ?? 45_000);
const pollMs = 750;

const createdSessions = [];

async function main() {
  const startedAt = new Date().toISOString();
  const health = await requestJson(
    "GET",
    "/global/health",
    undefined,
    "OpenCode server is unavailable. Start Retinue/OpenCode autoserve or set RETINUE_OPENCODE_BASE_URL."
  );
  const agents = await requestJson("GET", `/agent?directory=${encodeURIComponent(cwd)}`);
  const agentSummary = Array.isArray(agents)
    ? agents.map((agent) => ({
        name: agent.name,
        mode: agent.mode,
        native: agent.native,
        steps: agent.steps,
        permissionCount: Array.isArray(agent.permission) ? agent.permission.length : undefined
      }))
    : [];

  const results = [];
  results.push(await probeCurrentRunner());
  results.push(await probeParentChild());
  results.push(await probeFork());
  results.push(await probeSubtaskPart());
  results.push({ name: "agent_steps_surface", status: "completed", agents: agentSummary.filter((agent) => agent.steps !== undefined) });

  await cleanup();
  console.log(
    JSON.stringify(
      {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        baseUrl,
        cwd,
        health,
        agentSummary,
        results
      },
      null,
      2
    )
  );
}

async function probeCurrentRunner() {
  const session = await createSession({ title: "retinue-native-current-runner", agent: "explore" });
  const promptAccepted = await promptAsync(session.id, {
    agent: "explore",
    parts: [{ type: "text", text: "Do not use tools. Reply exactly: RETINUE_NATIVE_CURRENT_OK" }]
  });
  const observed = await waitForFinalText(session.id);
  return { name: "current_runner", sessionID: session.id, promptAccepted, ...observed };
}

async function probeParentChild() {
  const parent = await createSession({ title: "retinue-native-parent", agent: "build" });
  const child = await createSession({ title: "retinue-native-parent-child", parentID: parent.id, agent: "explore" });
  const childrenBeforePrompt = await sessionChildren(parent.id);
  const promptAccepted = await promptAsync(child.id, {
    agent: "explore",
    parts: [{ type: "text", text: "Do not use tools. Reply exactly: RETINUE_NATIVE_CHILD_OK" }]
  });
  const observed = await waitForFinalText(child.id);
  const childrenAfterPrompt = await sessionChildren(parent.id);
  return {
    name: "parent_child",
    parentID: parent.id,
    childID: child.id,
    childHasParentID: child.parentID === parent.id,
    childrenBeforePrompt: summarizeSessions(childrenBeforePrompt),
    childrenAfterPrompt: summarizeSessions(childrenAfterPrompt),
    promptAccepted,
    ...observed
  };
}

async function probeFork() {
  const parent = await createSession({ title: "retinue-native-fork-parent", agent: "build" });
  await promptAsync(parent.id, {
    agent: "build",
    parts: [{ type: "text", text: "Do not use tools. Reply exactly: RETINUE_NATIVE_FORK_PARENT_OK" }]
  });
  const parentObserved = await waitForFinalText(parent.id);
  const messages = await sessionMessages(parent.id);
  const lastMessageID = messages.at(-1)?.info?.id;
  let fork;
  let forkError;
  try {
    fork = await requestJson("POST", `/session/${encodeURIComponent(parent.id)}/fork?directory=${encodeURIComponent(cwd)}`, {
      messageID: typeof lastMessageID === "string" ? lastMessageID : undefined
    });
    createdSessions.push(fork.id);
  } catch (error) {
    forkError = error instanceof Error ? error.message : String(error);
  }
  return {
    name: "fork",
    parentID: parent.id,
    parentObserved,
    forkID: fork?.id,
    forkParentID: fork?.parentID,
    forkError
  };
}

async function probeSubtaskPart() {
  const parent = await createSession({ title: "retinue-native-subtask-parent", agent: "build" });
  const promptAccepted = await promptAsync(parent.id, {
    agent: "build",
    parts: [
      { type: "text", text: "Run the attached subtask, then return a concise final answer with the subtask result." },
      {
        type: "subtask",
        description: "deterministic explore subtask",
        agent: "explore",
        prompt: "Do not use tools. Reply exactly: RETINUE_NATIVE_SUBTASK_OK"
      }
    ]
  });
  const observed = await waitForFinalText(parent.id);
  const children = await sessionChildren(parent.id);
  return { name: "subtask_part", parentID: parent.id, promptAccepted, children: summarizeSessions(children), ...observed };
}

async function createSession(body) {
  const session = await requestJson("POST", `/session?directory=${encodeURIComponent(cwd)}`, body);
  createdSessions.push(session.id);
  return session;
}

async function promptAsync(sessionID, body) {
  await requestVoid("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async?directory=${encodeURIComponent(cwd)}`, body);
  return true;
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
    const text = extractText(message);
    const completed = message.info?.finish === "stop" || typeof message.info?.time?.completed === "number";
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
    completedAssistantCount: Array.isArray(messages) ? messages.filter((message) => message?.info?.role === "assistant" && latestCompletedAssistantText([message])).length : 0
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

function summarizeSessions(sessions) {
  return Array.isArray(sessions)
    ? sessions.map((session) => ({ id: session.id, parentID: session.parentID, title: session.title, agent: session.agent, directory: session.directory }))
    : [];
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
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
