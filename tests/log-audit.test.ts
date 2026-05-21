import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/audit-retinue-logs.mjs");

describe("Retinue log audit script", () => {
  it("summarizes recent stalled diagnostics into deduplicated issue candidates", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-20T07:00:00.000Z",
            event: "opencode_job_stalled",
            jobId: "old",
            diagnostic: { stallReason: "provider_blank_assistant", lastAssistantProviderID: "litellm", lastAssistantModelID: "semantic-router" }
          }),
          JSON.stringify({
            time: "2026-05-20T08:00:00.000Z",
            event: "opencode_job_stalled",
            jobId: "job_a",
            diagnostic: {
              sessionId: "ses_child",
              parentSessionId: "ses_parent",
              childSessionIds: ["ses_child"],
              sessionDirectory: "/repo",
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 90000ms.",
              softStallRescueSourceReason: "tool_loop_no_completion",
              softStallRescueSourceSummary: "OpenCode produced tool-call rounds with no final text.",
              recoveryStallReason: "provider_blank_assistant",
              recoveryStallSummary: "OpenCode provider/router produced blank assistant output for 90000ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              noCompletedAssistantDurationMs: 90000,
              blankAssistantRounds: 1,
              malformedReadToolParts: 1,
              runningReadToolPartSummaries: [
                {
                  tool: "read",
                  callID: "call_read_empty",
                  stateStatus: "pending",
                  stateInput: { type: "object", preview: "{}" }
                }
              ]
            }
          }),
          JSON.stringify({
            time: "2026-05-20T08:01:00.000Z",
            event: "opencode_job_result_read",
            jobId: "job_b",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 90000ms.",
              softStallRescueSourceReason: "tool_loop_no_completion",
              softStallRescueSourceSummary: "OpenCode produced tool-call rounds with no final text.",
              recoveryStallReason: "provider_blank_assistant",
              recoveryStallSummary: "OpenCode provider/router produced blank assistant output for 90000ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-20T08:02:00.000Z",
            event: "opencode_job_stalled",
            jobId: "job_c",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 90000ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-20T08:03:00.000Z",
            event: "opencode_job_result_read",
            jobId: "job_c",
            status: "completed",
            diagnostic: {
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          })
        ].join("\n")
      );

      const stdout = execFileSync(process.execPath, [scriptPath, "--trace", tracePath, "--since", "2026-05-20T07:30:00.000Z"], {
        encoding: "utf8"
      });
      const parsed = JSON.parse(stdout);

      expect(parsed.scannedEvents).toBe(4);
      expect(parsed.issueCount).toBe(1);
      expect(parsed.issues[0]).toMatchObject({
        count: 2,
        jobIds: ["job_a", "job_b"],
        title: "Investigate Retinue recovery provider_blank_assistant after tool_loop_no_completion on litellm/semantic-router",
        description: expect.stringContaining("rescueSource=tool_loop_no_completion"),
        sample: {
          jobId: "job_a",
          sessionId: "ses_child",
          parentSessionId: "ses_parent",
          childSessionIds: ["ses_child"],
          stallReason: "provider_blank_assistant",
          softStallRescueSourceReason: "tool_loop_no_completion",
          recoveryStallReason: "provider_blank_assistant",
          malformedReadToolParts: 1,
          runningReadToolPartSummaries: [
            {
              tool: "read",
              callID: "call_read_empty",
              stateStatus: "pending",
              stateInput: { type: "object", preview: "{}" }
            }
          ]
        }
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
