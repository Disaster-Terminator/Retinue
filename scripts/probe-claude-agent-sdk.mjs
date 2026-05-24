#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_EXPECTED = "RETINUE_CLAUDE_SDK_OK";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const messages = [];
  const permissionRequests = [];
  const prompt = options.permission
    ? "Use the Read tool to read /etc/hostname, then summarize whether the read succeeded."
    : `Reply exactly: ${options.expected}`;

  const canUseTool = options.permission
    ? async (toolName, input, hook) => {
        permissionRequests.push({
          toolName,
          input,
          title: hook.title,
          displayName: hook.displayName,
          description: hook.description,
          blockedPath: hook.blockedPath,
          decisionReason: hook.decisionReason,
          toolUseID: hook.toolUseID,
          agentID: hook.agentID,
          suggestions: hook.suggestions?.length ?? 0
        });
        return {
          behavior: "deny",
          message: "Retinue Claude SDK probe denied this tool call",
          toolUseID: hook.toolUseID
        };
      }
    : undefined;

  for await (const message of query({
    prompt,
    options: {
      cwd: options.cwd,
      maxTurns: options.permission ? 3 : 1,
      ...(options.permission ? { tools: ["Read"], canUseTool } : {})
    }
  })) {
    messages.push(projectMessage(message));
  }

  const result = messages.findLast((message) => message.type === "result");
  if (!result) {
    throw new Error("Claude Agent SDK probe did not emit a result message");
  }
  if (result.is_error) {
    throw new Error(`Claude Agent SDK probe returned an error result: ${String(result.result ?? "")}`);
  }
  if (!options.permission && result.result !== options.expected) {
    throw new Error(`Expected Claude Agent SDK result ${JSON.stringify(options.expected)}, got ${JSON.stringify(result.result)}`);
  }
  if (options.permission && permissionRequests.length === 0) {
    throw new Error("Claude Agent SDK permission probe did not invoke canUseTool");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: options.permission ? "permission" : "query",
        result: result.result,
        sessionId: result.sessionId,
        permissionRequests,
        messageTypes: messages.map((message) => message.type)
      },
      null,
      2
    )}\n`
  );
}

function parseArgs(args) {
  const options = {
    cwd: process.cwd(),
    expected: DEFAULT_EXPECTED,
    permission: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--expect") {
      options.expected = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--permission") {
      options.permission = true;
      continue;
    }
    throw new Error(`Unknown Claude Agent SDK probe flag: ${arg}`);
  }

  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function projectMessage(message) {
  return {
    type: message.type,
    subtype: message.subtype,
    sessionId: message.session_id ?? message.sessionId,
    result: message.result,
    is_error: message.is_error
  };
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
