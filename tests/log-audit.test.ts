import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, renderCompactAuditResult } from "../src/cli/auditRetinueLogs.js";
import { auditRetinueLogs } from "../src/core/logAudit.js";

describe("Retinue log audit", () => {
  it("prints compact audit output by default and full JSON only when requested", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-cli-default-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.writeFileSync(
        tracePath,
        JSON.stringify({
          time: "2026-05-25T12:30:00.000Z",
          event: "opencode_job_stalled",
          jobId: "job_default_compact",
          status: "stalled",
          diagnostic: {
            stallReason: "provider_zero_progress",
            stallSummary: "OpenCode provider/router made no progress.",
            lastAssistantProviderID: "litellm",
            lastAssistantModelID: "intentmux",
            lastAssistantAgent: "explore",
            lastAssistantMode: "explore"
          }
        })
      );

      const compact = await captureStdout(() =>
        main(["--trace", tracePath, "--since", "2026-05-25T12:00:00.000Z"], { ...process.env, RETINUE_STATE_DIR: tempDir })
      );
      expect(compact).toContain("Retinue log audit: issues=1 attention=0 scanned=1 ignoredCompleted=0");
      expect(compact).toContain("#1 count=1 jobs=job_default_compact");
      expect(() => JSON.parse(compact)).toThrow();

      const json = await captureStdout(() =>
        main(["--trace", tracePath, "--since", "2026-05-25T12:00:00.000Z", "--json"], { ...process.env, RETINUE_STATE_DIR: tempDir })
      );
      const parsed = JSON.parse(json);
      expect(parsed.issueCount).toBe(1);
      expect(parsed.issues[0].jobIds).toEqual(["job_default_compact"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces backend_unreachable trace events as infrastructure issues", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-backend-unreachable-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-25T12:30:00.000Z",
            event: "opencode_job_backend_unreachable",
            jobId: "job_backend_down",
            status: "backend_unreachable",
            diagnostic: {
              baseUrl: "http://127.0.0.1:4098",
              sessionId: "ses_backend_down",
              sessionDirectory: "/repo",
              error: "fetch failed"
            }
          })
        ].join("\n")
      );

      const result = await auditRetinueLogs({ tracePath, stateDir: tempDir, since: new Date("2026-05-25T12:00:00.000Z") });
      expect(result.issueCount).toBe(1);
      expect(result.issues[0]).toMatchObject({
        title: "Investigate Retinue backend_unreachable for OpenCode server",
        jobIds: ["job_backend_down"],
        sample: {
          problemStatus: "backend_unreachable",
          baseUrl: "http://127.0.0.1:4098",
          error: "fetch failed"
        }
      });
      const compact = renderCompactAuditResult(result);
      expect(compact).toContain("reason=backend_unreachable");
      expect(compact).toContain("baseUrl=http://127.0.0.1:4098");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces requested backend agent metadata when no assistant round exists", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-requested-agent-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.mkdirSync(path.join(tempDir, "jobs", "job_wrong_agent"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "jobs", "job_wrong_agent", "meta.json"),
        JSON.stringify({
          jobId: "job_wrong_agent",
          status: "stalled",
          backend: "opencode",
          agent: "codex-gpt-5.5",
          updatedAt: "2026-06-08T09:46:00.000Z"
        })
      );
      fs.writeFileSync(
        tracePath,
        JSON.stringify({
          time: "2026-06-08T09:46:00.000Z",
          event: "opencode_job_stalled",
          jobId: "job_wrong_agent",
          status: "stalled",
          diagnostic: {
            baseUrl: "http://127.0.0.1:4099",
            sessionDirectory: "/home/raystorm/projects/Vela",
            stallReason: "provider_zero_progress",
            stallSummary: "OpenCode provider/router produced zero-progress assistant output for 120000ms.",
            noCompletedAssistantDurationMs: 120000
          }
        })
      );

      const parsed = await auditRetinueLogs({ tracePath, stateDir: tempDir, since: new Date("2026-06-08T09:00:00.000Z") });

      expect(parsed.issueCount).toBe(1);
      expect(parsed.issues[0]).toMatchObject({
        description: expect.stringContaining("requestedAgent=codex-gpt-5.5"),
        sample: {
          requestedAgent: "codex-gpt-5.5"
        }
      });
      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("agent=unknown_agent/unknown_mode");
      expect(compact).toContain("requestedAgent=codex-gpt-5.5");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
      expect(parsed.attentionCount).toBe(0);
      expect(parsed.issues[0]).toMatchObject({
        count: 2,
        jobIds: ["job_a", "job_b"],
        title: "Investigate Retinue recovery provider_blank_assistant on litellm/semantic-router",
        description: expect.stringContaining("recovery=provider_blank_assistant"),
        sample: {
          jobId: "job_a",
          sessionId: "ses_child",
          parentSessionId: "ses_parent",
          childSessionIds: ["ses_child"],
          stallReason: "provider_blank_assistant",
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
      expect(compact).toContain("Retinue log audit: issues=1 attention=0 scanned=4 ignoredCompleted=1");
      expect(compact).toContain("#1 count=2 jobs=job_a,job_b");
      expect(compact).toContain("reason=provider_blank_assistant");
      expect(compact).toContain("recovery=provider_blank_assistant");
      expect(compact).toContain("provider=litellm/semantic-router");
      expect(compact).toContain("agent=explore/explore");
      expect(compact).toContain("malformedRead=1");
      expect(compact).toContain("title=Investigate Retinue recovery provider_blank_assistant on litellm/semantic-router");
      expect(compact).not.toContain("runningReadToolPartSummaries");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses historical terminal non-completed jobs but includes them in since-window audits", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-terminal-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.mkdirSync(path.join(tempDir, "jobs", "job_killed"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "jobs", "job_killed", "meta.json"),
        JSON.stringify({ jobId: "job_killed", status: "killed", updatedAt: "2026-05-25T12:29:00.000Z" })
      );
      fs.writeFileSync(
        tracePath,
        JSON.stringify({
          time: "2026-05-25T12:30:00.000Z",
          event: "opencode_job_stalled",
          jobId: "job_killed",
          status: "stalled",
          diagnostic: {
            stallReason: "provider_zero_progress",
            stallSummary: "OpenCode provider/router made no progress.",
            lastAssistantProviderID: "litellm",
            lastAssistantModelID: "intentmux",
            lastAssistantAgent: "explore",
            lastAssistantMode: "explore"
          }
        })
      );

      const defaultResult = await auditRetinueLogs({ tracePath, stateDir: tempDir });
      expect(defaultResult.issueCount).toBe(0);
      expect(defaultResult.ignoredTerminalJobIds).toEqual(["job_killed"]);
      expect(renderCompactAuditResult(defaultResult)).toContain(
        "Retinue log audit: issues=0 attention=0 scanned=1 ignoredCompleted=0 ignoredTerminal=1"
      );

      const sinceResult = await auditRetinueLogs({
        tracePath,
        stateDir: tempDir,
        since: new Date("2026-05-25T12:00:00.000Z")
      });
      expect(sinceResult.issueCount).toBe(1);
      expect(sinceResult.issues[0].jobIds).toEqual(["job_killed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("warns when the bounded audit window may not cover the requested since timestamp", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-truncated-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      const lines = [
        JSON.stringify({
          time: "2026-05-20T08:00:00.000Z",
          event: "opencode_job_stalled",
          jobId: "job_hidden_by_tail",
          status: "stalled",
          diagnostic: {
            stallReason: "provider_blank_assistant",
            lastAssistantProviderID: "litellm",
            lastAssistantModelID: "intentmux",
            lastAssistantAgent: "explore",
            lastAssistantMode: "explore"
          }
        }),
        ...Array.from({ length: 20 }, (_, index) =>
          JSON.stringify({
            time: `2026-05-20T09:${String(index).padStart(2, "0")}:00.000Z`,
            event: "opencode_job_result_read",
            jobId: `job_completed_${index}`,
            status: "completed",
            diagnostic: {
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "intentmux",
              selectedAssistantTextBytes: 20_000
            }
          })
        )
      ];
      fs.writeFileSync(tracePath, `${lines.join("\n")}\n`);

      const parsed = await auditRetinueLogs({
        tracePath,
        since: new Date("2026-05-20T08:00:00.000Z"),
        maxBytes: 600,
        maxLines: 100
      });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.inputTruncated).toBe(true);
      expect(parsed.truncatedBeforeSince).toBe(true);
      expect(parsed.oldestScannedEvent).not.toBe("2026-05-20T08:00:00.000Z");

      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("warning=scan_truncated_before_since");
      expect(compact).toContain("increase --max-bytes or --max-lines");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("separates OpenCode external-directory permission waits from backend issues", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-attention-"));
    try {
      const tracePath = path.join(tempDir, "retinue.jsonl");
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-25T11:52:06.000Z",
            event: "opencode_job_stalled",
            jobId: "job_permission",
            status: "stalled",
            diagnostic: {
              sessionId: "ses_child",
              sessionDirectory: "/home/raystorm/projects/Vela",
              stallReason: "external_directory_permission_pending",
              stallSummary: "OpenCode is waiting for external_directory permission.",
              pendingPermissionCount: 2,
              pendingExternalDirectoryPermissionCount: 2,
              pendingExternalDirectoryPermissions: [
                {
                  id: "per_1",
                  permission: "external_directory",
                  patterns: ["/home/raystorm/projects/opencode/*"],
                  toolCallID: "call_read",
                  approval: {
                    recommendedReply: "reject",
                    recommendedMessage: "The requested path is outside the delegated workspace.",
                    scope: {
                      target: "/home/raystorm/projects/opencode",
                      relation: "outside_workspace"
                    }
                  }
                }
              ],
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "doubao-seed-2.0-lite",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              noCompletedAssistantDurationMs: 104010
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ tracePath, since: new Date("2026-05-25T11:00:00.000Z") });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.issues).toEqual([]);
      expect(parsed.attentionCount).toBe(1);
      expect(parsed.attentions[0]).toMatchObject({
        kind: "permission",
        count: 1,
        jobIds: ["job_permission"],
        title: "Resolve Retinue external_directory permission on litellm/doubao-seed-2.0-lite",
        sample: {
          jobId: "job_permission",
          stallReason: "external_directory_permission_pending",
          pendingPermissionCount: 2,
          pendingExternalDirectoryPermissionCount: 2,
          permissionActions: [
            {
              id: "per_1",
              permission: "external_directory",
              target: "/home/raystorm/projects/opencode",
              patterns: ["/home/raystorm/projects/opencode/*"],
              toolCallID: "call_read",
              recommendedReply: "reject",
              recommendedMessage: "The requested path is outside the delegated workspace.",
              relation: "outside_workspace"
            }
          ]
        }
      });

      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("Retinue log audit: issues=0 attention=1 scanned=1 ignoredCompleted=0");
      expect(compact).toContain("#A1 count=1 jobs=job_permission");
      expect(compact).toContain("reason=external_directory_permission_pending");
      expect(compact).toContain("permissions=2");
      expect(compact).toContain("title=Resolve Retinue external_directory permission on litellm/doubao-seed-2.0-lite");
      expect(compact).toContain(
        "permission[1] id=per_1 permission=external_directory target=/home/raystorm/projects/opencode patterns=/home/raystorm/projects/opencode/* toolCall=call_read recommended=reject relation=outside_workspace"
      );
      expect(compact).not.toContain("pendingPermissions=per_1");
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
        title: "Investigate Retinue recovery read_tool_invalid_input on litellm/intentmux",
        sample: {
          jobId: "job_root",
          chainRootJobId: "job_root",
          stallReason: "read_tool_invalid_input",
          recoveryStallReason: "read_tool_invalid_input",
          selectedAttemptJobId: "job_attempt",
          attemptChainPresent: true,
          malformedReadToolParts: 1
        }
      });

      const compact = renderCompactAuditResult(parsed);
      expect(compact).toContain("Retinue log audit: issues=1 attention=0 scanned=3 ignoredCompleted=0");
      expect(compact).toContain("#1 count=3 jobs=job_root,job_attempt");
      expect(compact).toContain("reason=read_tool_invalid_input recovery=read_tool_invalid_input");
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

  it("suppresses recovered task-level attempts when the retry attempt completes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retinue-log-audit-task-attempt-completed-"));
    try {
      const tracePath = path.join(tempDir, "logs", "retinue.jsonl");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.writeFileSync(
        tracePath,
        [
          JSON.stringify({
            time: "2026-05-31T09:04:59.989Z",
            event: "opencode_job_stalled",
            jobId: "job_root",
            status: "stalled",
            diagnostic: {
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 45190ms.",
              lastAssistantProviderID: "litellm-cloud",
              lastAssistantModelID: "doubao-seed-2.0-lite",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-31T09:05:00.068Z",
            event: "opencode_task_level_attempt_started",
            jobId: "job_root",
            status: "stalled",
            attemptJobId: "job_attempt",
            attempt: 1,
            recoveryReason: "provider_blank_assistant",
            originalStallReason: "provider_blank_assistant",
            recoveryStallReason: "provider_blank_assistant",
            diagnostic: {
              stallReason: "provider_blank_assistant",
              stallSummary: "OpenCode provider/router produced blank assistant output for 45270ms.",
              lastAssistantProviderID: "litellm-cloud",
              lastAssistantModelID: "doubao-seed-2.0-lite",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore"
            }
          }),
          JSON.stringify({
            time: "2026-05-31T09:05:18.650Z",
            event: "opencode_job_result_read",
            jobId: "job_attempt",
            status: "completed",
            diagnostic: {
              lastAssistantProviderID: "litellm-cloud",
              lastAssistantModelID: "doubao-seed-2.0-lite",
              lastAssistantAgent: "explore",
              lastAssistantMode: "explore",
              selectedAssistantTextBytes: 721
            }
          })
        ].join("\n")
      );

      const parsed = await auditRetinueLogs({ stateDir: tempDir, tracePath, since: new Date("2026-05-31T09:00:00.000Z") });

      expect(parsed.issueCount).toBe(0);
      expect(parsed.ignoredCompletedJobIds).toEqual(["job_attempt"]);
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

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return writes.join("");
}
