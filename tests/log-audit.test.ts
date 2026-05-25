import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompactAuditResult } from "../src/cli/auditRetinueLogs.js";
import { auditRetinueLogs } from "../src/core/logAudit.js";

describe("Retinue log audit", () => {
  it("summarizes recent stalled diagnostics into deduplicated issue candidates", async () => {
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

      const parsed = await auditRetinueLogs({ tracePath, since: new Date("2026-05-20T07:30:00.000Z") });

      expect(parsed.scannedEvents).toBe(4);
      expect(parsed.ignoredCompletedJobIds).toEqual(["job_c"]);
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

      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("Retinue log audit: issues=1 scanned=4 ignoredCompleted=1");
      expect(compact).toContain("#1 count=2 jobs=job_a,job_b");
      expect(compact).toContain("reason=provider_blank_assistant");
      expect(compact).toContain("source=tool_loop_no_completion");
      expect(compact).toContain("recovery=provider_blank_assistant");
      expect(compact).toContain("provider=litellm/semantic-router");
      expect(compact).toContain("agent=explore/explore");
      expect(compact).toContain("malformedRead=1");
      expect(compact).toContain("title=Investigate Retinue recovery provider_blank_assistant after tool_loop_no_completion on litellm/semantic-router");
      expect(compact).not.toContain("runningReadToolPartSummaries");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("groups stalled recovery chains by root job instead of splitting each stall reason", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-chain-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T08:31:42.000Z",
            event: "opencode_job_stalled",
            jobId: "job_root",
            status: "stalled",
            diagnostic: {
              sessionId: "ses_root",
              sessionDirectory: "/repo",
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 48481ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              noCompletedAssistantDurationMs: 48481,
              blankAssistantRounds: 1
            }
          }),
          JSON.stringify({
            time: "2026-05-24T08:31:44.000Z",
            event: "opencode_job_stalled",
            jobId: "job_root",
            status: "stalled",
            selectedAttemptJobId: "job_attempt",
            attemptChain: [{ jobId: "job_root" }, { jobId: "job_attempt" }],
            diagnostic: {
              sessionId: "ses_root",
              sessionDirectory: "/repo",
              stallReason: "read_tool_invalid_input",
              stallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input for 50424ms. readToolCalls=call_bad:pending:input={}.",
              softStallRescueSourceReason: "provider_blank_assistant",
              softStallRescueSourceSummary: "OpenCode provider/router produced blank assistant output for 48496ms.",
              recoveryStallReason: "read_tool_invalid_input",
              recoveryStallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input for 50424ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              noCompletedAssistantDurationMs: 50424,
              malformedReadToolParts: 1,
              runningReadToolPartSummaries: [
                {
                  tool: "read",
                  callID: "call_bad",
                  stateStatus: "pending",
                  stateInput: { type: "object", preview: "{}" }
                }
              ]
            }
          }),
          JSON.stringify({
            time: "2026-05-24T08:32:29.000Z",
            event: "opencode_job_stalled",
            jobId: "job_attempt",
            status: "stalled",
            diagnostic: {
              sessionId: "ses_attempt",
              sessionDirectory: "/repo",
              stallReason: "read_tool_invalid_input",
              stallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input for 45250ms. readToolCalls=call_attempt:pending:input={}.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              noCompletedAssistantDurationMs: 45250,
              malformedReadToolParts: 1,
              runningReadToolPartSummaries: [
                {
                  tool: "read",
                  callID: "call_attempt",
                  stateStatus: "pending",
                  stateInput: { type: "object", preview: "{}" }
                }
              ]
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ tracePath, since: new Date("2026-05-24T08:25:00.000Z") });

      expect(parsed.issueCount).toBe(1);
      expect(parsed.issues[0]).toMatchObject({
        signature: "chain|job_root|litellm|intentmux|explore|explore",
        count: 3,
        jobIds: ["job_root", "job_attempt"],
        title: "Investigate Retinue recovery read_tool_invalid_input after provider_blank_assistant on litellm/intentmux",
        sample: {
          jobId: "job_root",
          chainRootJobId: "job_root",
          stallReason: "read_tool_invalid_input",
          softStallRescueSourceReason: "provider_blank_assistant",
          recoveryStallReason: "read_tool_invalid_input",
          selectedAttemptJobId: "job_attempt",
          attemptChainPresent: true,
          malformedReadToolParts: 1
        }
      });

      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("Retinue log audit: issues=1 scanned=3 ignoredCompleted=0");
      expect(compact).toContain("#1 count=3 jobs=job_root,job_attempt");
      expect(compact).toContain("reason=read_tool_invalid_input source=provider_blank_assistant recovery=read_tool_invalid_input");
      expect(compact).toContain("provider=litellm/intentmux");
      expect(compact).toContain("selectedAttempt=job_attempt");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores stalled selected attempts when the root job later completes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-chain-completed-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.mkdirSync(path.join(tempDir, "jobs", "job_root"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "jobs", "job_attempt"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "jobs", "job_root", "meta.json"), JSON.stringify({ jobId: "job_root", selectedAttemptJobId: "job_attempt" }));
      fs.writeFileSync(path.join(tempDir, "jobs", "job_attempt", "meta.json"), JSON.stringify({ jobId: "job_attempt", recoveredFromJobId: "job_root" }));
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T08:31:44.000Z",
            event: "opencode_job_stalled",
            jobId: "job_root",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_zero_progress",
              stallSummary: "OpenCode provider/router produced zero-progress assistant output for 45000ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-24T08:32:29.000Z",
            event: "opencode_job_result_read",
            jobId: "job_attempt",
            status: "stalled",
            diagnostic: {
              stallReason: "read_tool_invalid_input",
              stallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input for 45250ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              malformedReadToolParts: 1
            }
          }),
          JSON.stringify({
            time: "2026-05-24T08:32:45.000Z",
            event: "opencode_job_status_changed",
            jobId: "job_root",
            status: "completed",
            diagnostic: {
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "build",
              lastAssistantMode: "build",
              selectedAssistantTextBytes: 8270
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ stateDir: tempDir, tracePath, since: new Date("2026-05-24T08:25:00.000Z") });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.ignoredCompletedJobIds).toEqual(["job_root"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses job metadata to link selected attempts when the trace window misses the linking event", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-meta-chain-"));
    try {
      const tracePath = path.join(tempDir, "logs", "retinue.jsonl");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "jobs", "job_root"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "jobs", "job_attempt"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "jobs", "job_root", "meta.json"), JSON.stringify({ jobId: "job_root", selectedAttemptJobId: "job_attempt" }));
      fs.writeFileSync(path.join(tempDir, "jobs", "job_attempt", "meta.json"), JSON.stringify({ jobId: "job_attempt", recoveredFromJobId: "job_root" }));
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T08:31:42.000Z",
            event: "opencode_job_stalled",
            jobId: "job_root",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 48481ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-24T08:32:29.000Z",
            event: "opencode_job_stalled",
            jobId: "job_attempt",
            status: "stalled",
            diagnostic: {
              stallReason: "read_tool_invalid_input",
              stallSummary: "OpenCode provider/model emitted read tool call(s) with missing or invalid input for 45250ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              malformedReadToolParts: 1
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ stateDir: tempDir, tracePath, since: new Date("2026-05-24T08:25:00.000Z") });

      expect(parsed.issueCount).toBe(1);
      expect(parsed.issues[0]).toMatchObject({
        signature: "chain|job_root|litellm|intentmux|explore|explore",
        count: 2,
        jobIds: ["job_root", "job_attempt"],
        sample: {
          jobId: "job_attempt",
          chainRootJobId: "job_root",
          stallReason: "read_tool_invalid_input",
          malformedReadToolParts: 1
        }
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report jobs whose latest trace event is still soft-stall rescue pending", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-pending-rescue-"));
    try {
      const tracePath = path.join(tempDir, "logs", "retinue.jsonl");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T16:39:33.000Z",
            event: "opencode_job_stalled",
            jobId: "job_pending",
            status: "stalled",
            diagnostic: {
              stallReason: "incomplete_assistant_round",
              stallSummary: "OpenCode left the latest assistant round incomplete for 45188ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-24T16:39:34.000Z",
            event: "opencode_job_soft_stall_rescue_submitted",
            jobId: "job_pending",
            status: "running",
            diagnostic: {
              stallReason: "incomplete_assistant_round",
              softStallRescueSourceReason: "incomplete_assistant_round",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-24T16:39:48.000Z",
            event: "opencode_job_soft_stall_rescue_pending",
            jobId: "job_pending",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_zero_progress",
              stallSummary: "OpenCode provider/router produced zero-progress assistant output for 60056ms.",
              softStallRescueSourceReason: "incomplete_assistant_round",
              recoveryStallReason: "provider_zero_progress",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "build",
              lastAssistantMode: "build"
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ stateDir: tempDir, tracePath, since: new Date("2026-05-24T16:30:00.000Z") });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.ignoredCompletedJobIds).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses persisted completed job metadata to suppress stale stalled trace events", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-completed-meta-"));
    try {
      const tracePath = path.join(tempDir, "logs", "retinue.jsonl");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "jobs", "job_completed"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "jobs", "job_completed", "meta.json"),
        JSON.stringify({
          jobId: "job_completed",
          status: "completed",
          updatedAt: "2026-05-24T16:42:08.000Z"
        })
      );
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T16:39:33.000Z",
            event: "opencode_job_stalled",
            jobId: "job_completed",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_zero_progress",
              stallSummary: "OpenCode provider/router produced zero-progress assistant output for 60056ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "build",
              lastAssistantMode: "build"
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ stateDir: tempDir, tracePath, since: new Date("2026-05-24T16:30:00.000Z") });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.ignoredCompletedJobIds).toEqual(["job_completed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses an injected reconciler to suppress live-completed stale stalled jobs", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-live-reconcile-"));
    try {
      const tracePath = path.join(tempDir, "logs", "retinue.jsonl");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "jobs", "job_late_completed"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "jobs", "job_late_completed", "meta.json"),
        JSON.stringify({
          jobId: "job_late_completed",
          backend: "opencode",
          status: "stalled",
          externalServerUrl: "http://127.0.0.1:4096",
          externalSessionId: "ses_late_completed",
          updatedAt: "2026-05-24T16:39:33.000Z"
        })
      );
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-24T16:39:33.000Z",
            event: "opencode_job_stalled",
            jobId: "job_late_completed",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_zero_progress",
              stallSummary: "OpenCode provider/router produced zero-progress assistant output for 60056ms.",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          })
        ].join("\n")
      );
      const reconciled: string[] = [];

      const parsed = await auditRetinueLogs({
        stateDir: tempDir,
        tracePath,
        since: new Date("2026-05-24T16:30:00.000Z"),
        reconcileStatus: async (jobId, meta) => {
          reconciled.push(`${jobId}:${String(meta.externalSessionId)}`);
          return "completed";
        }
      });

      expect(reconciled).toEqual(["job_late_completed:ses_late_completed"]);
      expect(parsed.issueCount).toBe(0);
      expect(parsed.ignoredCompletedJobIds).toEqual(["job_late_completed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
