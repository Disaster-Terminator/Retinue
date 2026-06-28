import { describe, expect, it } from "vitest";
import { classifyDogfoodWait, summarizeDogfoodResults } from "../scripts/lib/dogfood-summary.mjs";

describe("dogfood probe classification", () => {
  it("accepts completed jobs only when the expected marker is present", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_ok",
        status: "completed",
        stdoutPreview: "PASS\nRETINUE_DOGFOOD_REVIEW_DONE"
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: true,
      failureReason: undefined
    });
  });

  it("checks completion markers against full stdout without exposing it in the summary", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_long",
        status: "completed",
        stdoutText: `${"x".repeat(600)}\nPASS\nRETINUE_DOGFOOD_REVIEW_DONE`,
        stdoutPreview: "x".repeat(500)
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: true,
      failureReason: undefined,
      stdoutPreview: "x".repeat(500)
    });
    expect(wait).not.toHaveProperty("stdoutText");
  });

  it("rejects stalled provider output even when the child returned useful text", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_zero_progress",
        status: "stalled",
        stallReason: "provider_zero_progress",
        stdoutPreview: "Finding: the test grouping is incomplete."
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "provider_zero_progress"
    });
  });

  it("rejects completed jobs that did not produce the requested final marker", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_partial",
        status: "completed",
        stdoutPreview: "Let me inspect package.json first."
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "missing_completion_marker"
    });
  });

  it("rejects children that report FAIL even when the completion marker is present", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_fail",
        status: "completed",
        stdoutPreview: "FAIL\nFinding: dogfood gate is incomplete.\nRETINUE_DOGFOOD_REVIEW_DONE"
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "child_reported_fail"
    });
  });

  it("accepts PASS verdicts even when evidence text later mentions failure behavior", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_pass_with_failure_evidence",
        status: "completed",
        stdoutPreview: "PASS\nFinding: the guardrail means a regression would fail CI.\nRETINUE_DOGFOOD_REVIEW_DONE"
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: true,
      failureReason: undefined
    });
  });

  it("rejects completed children that do not provide a PASS verdict", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_no_verdict",
        status: "completed",
        stdoutPreview: "The workflow looks acceptable.\nRETINUE_DOGFOOD_REVIEW_DONE"
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "missing_pass_verdict"
    });
  });

  it("rejects completed writable probes when the local file verification fails", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "writable",
        jobId: "job_writable",
        status: "completed",
        stdoutPreview: "PASS\nRETINUE_WRITABLE_DOGFOOD_DONE",
        filePath: "/tmp/retinue-writable/notes.txt",
        fileTextPreview: "status: pending\n",
        fileVerificationPassed: false
      },
      "RETINUE_WRITABLE_DOGFOOD_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "file_verification_failed",
      filePath: "/tmp/retinue-writable/notes.txt",
      fileTextPreview: "status: pending\n",
      fileVerificationPassed: false
    });
  });

  it("summarizes dogfood pressure failures as a failed run", () => {
    const summary = summarizeDogfoodResults([
      {
        agent: "plan",
        waits: [
          classifyDogfoodWait(
            {
              task_name: "ok",
              jobId: "job_ok",
              status: "completed",
              stdoutPreview: "PASS RETINUE_DOGFOOD_OK_DONE"
            },
            "RETINUE_DOGFOOD_OK_DONE"
          ),
          classifyDogfoodWait(
            {
              task_name: "provider",
              jobId: "job_provider",
              status: "stalled",
              stallReason: "provider_zero_progress",
              stallSummary: "OpenCode provider/router produced zero-progress assistant output.",
              lastAssistantAgent: "plan",
              lastAssistantMode: "plan",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              toolCallAssistantRounds: 3,
              runningReadToolParts: 1,
              runningReadToolCallIds: ["call_read"],
              runningReadToolPartSummaries: [{ type: "tool", tool: "read", callID: "call_read", stateStatus: "running" }],
              stdoutPath: "/tmp/retinue/jobs/job_provider/stdout.log",
              stderrPath: "/tmp/retinue/jobs/job_provider/stderr.log",
              stdoutPreview: "Reasoning only"
            },
            "RETINUE_DOGFOOD_PROVIDER_DONE"
          )
        ]
      }
    ]);

    expect(summary).toMatchObject({
      ok: false,
      completed: 1,
      stalled: 1,
      failed: 1,
      failureReasons: {
        provider_zero_progress: 1
      }
    });
    expect(summary.failedJobs).toEqual([
      {
        task_name: "provider",
        jobId: "job_provider",
        status: "stalled",
        stallReason: "provider_zero_progress",
        stallSummary: "OpenCode provider/router produced zero-progress assistant output.",
        failureReason: "provider_zero_progress",
        lastAssistantAgent: "plan",
        lastAssistantMode: "plan",
        lastAssistantProviderID: "litellm",
        lastAssistantModelID: "semantic-router",
        toolCallAssistantRounds: 3,
        runningReadToolParts: 1,
        runningReadToolCallIds: ["call_read"],
        runningReadToolPartSummaries: [{ type: "tool", tool: "read", callID: "call_read", stateStatus: "running" }],
        stdoutPath: "/tmp/retinue/jobs/job_provider/stdout.log",
        stderrPath: "/tmp/retinue/jobs/job_provider/stderr.log",
        stdoutPreview: "Reasoning only"
      }
    ]);
  });

  it("classifies external directory permission waits as action-required instead of provider stalls", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "permission",
        jobId: "job_permission",
        status: "stalled",
        stallReason: "external_directory_permission_pending",
        stallSummary: "OpenCode is waiting for external_directory permission.",
        permissionRequired: true,
        attentionRequiredKind: "permission",
        permissionCount: 2,
        permissions: [
          { id: "per_home", permission: "external_directory", patterns: ["/home/raystorm/*"] },
          { id: "per_config", permission: "external_directory", patterns: ["/home/raystorm/.config/*"] }
        ],
        lastAssistantProviderID: "litellm",
        lastAssistantModelID: "semantic-router"
      },
      "RETINUE_DOGFOOD_PERMISSION_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      permissionRequired: true,
      failureReason: "permission_required:external_directory"
    });

    const summary = summarizeDogfoodResults([{ agent: "explore", waits: [wait] }]);
    expect(summary).toMatchObject({
      ok: false,
      stalled: 1,
      actionRequired: 1,
      failed: 1,
      failureReasons: {
        "permission_required:external_directory": 1
      },
      failedJobs: [
        {
          task_name: "permission",
          jobId: "job_permission",
          status: "stalled",
          stallReason: "external_directory_permission_pending",
          permissionRequired: true,
          attentionRequiredKind: "permission",
          permissionCount: 2,
          permissions: [
            { id: "per_home", permission: "external_directory", patterns: ["/home/raystorm/*"] },
            { id: "per_config", permission: "external_directory", patterns: ["/home/raystorm/.config/*"] }
          ],
          failureReason: "permission_required:external_directory"
        }
      ]
    });
  });

  it("classifies Deepseek thinking-mode provider errors separately from generic Retinue stalls", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "provider",
        jobId: "job_provider",
        status: "stalled",
        stallReason: "provider_error",
        lastAssistantProviderID: "litellm",
        lastAssistantModelID: "semantic-router",
        stdoutText:
          'OpenCode provider returned an assistant error before producing final text. Error summary: {"message":"litellm.BadRequestError: DeepseekException - {\\"error\\":{\\"message\\":\\"The `reasoning_content` in the thinking mode must be passed back to the API.\\"}}"}',
        stdoutPreview: "OpenCode provider returned an assistant error before producing final text."
      },
      "RETINUE_DOGFOOD_PROVIDER_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "provider_error:deepseek_reasoning_content",
      providerErrorKind: "deepseek_reasoning_content",
      providerErrorHint: "Deepseek thinking-mode routing requires reasoning_content continuity; check LiteLLM/OpenCode router configuration."
    });

    const summary = summarizeDogfoodResults([{ agent: "explore", waits: [wait] }]);
    expect(summary).toMatchObject({
      ok: false,
      failed: 1,
      failureReasons: {
        "provider_error:deepseek_reasoning_content": 1
      },
      failedJobs: [
        {
          task_name: "provider",
          jobId: "job_provider",
          stallReason: "provider_error",
          providerErrorKind: "deepseek_reasoning_content",
          providerErrorHint: "Deepseek thinking-mode routing requires reasoning_content continuity; check LiteLLM/OpenCode router configuration."
        }
      ]
    });
  });

  it("classifies Deepseek function-call prefix provider errors separately", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "provider-prefix",
        jobId: "job_provider_prefix",
        status: "completed",
        stallReason: "provider_error",
        stdoutText:
          'OpenCode provider returned an assistant error. Error summary: {"message":"litellm.BadRequestError: DeepseekException - {\\"error\\":{\\"message\\":\\"Function call should not be used with prefix\\"}}"}',
        stdoutPreview: "OpenCode provider returned an assistant error."
      },
      "RETINUE_DOGFOOD_PROVIDER_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "provider_error:deepseek_function_call_prefix",
      providerErrorKind: "deepseek_function_call_prefix",
      providerErrorHint: "Deepseek rejected a tool/function-call fallback with prefix text; check router fallback compatibility for OpenCode tool calls."
    });
  });
});
