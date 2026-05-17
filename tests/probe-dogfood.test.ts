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

  it("rejects read-only write intent even when the child returned useful text", () => {
    const wait = classifyDogfoodWait(
      {
        task_name: "review",
        jobId: "job_patch",
        status: "stalled",
        stallReason: "read_only_write_intent",
        readOnlyWriteIntent: true,
        stdoutPreview: "Finding: the test grouping is incomplete."
      },
      "RETINUE_DOGFOOD_REVIEW_DONE"
    );

    expect(wait).toMatchObject({
      usable: false,
      failureReason: "read_only_write_intent"
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
              task_name: "patch",
              jobId: "job_patch",
              status: "stalled",
              stallReason: "read_only_write_intent",
              stallSummary: "OpenCode read-only job emitted patch/write intent.",
              readOnlyWriteIntent: true,
              lastAssistantAgent: "plan",
              lastAssistantMode: "plan",
              lastAssistantProviderID: "litellm",
              lastAssistantModelID: "semantic-router",
              toolCallAssistantRounds: 3,
              runningReadToolParts: 1,
              runningReadToolCallIds: ["call_read"],
              runningReadToolPartSummaries: [{ type: "tool", tool: "read", callID: "call_read", stateStatus: "running" }],
              stdoutPath: "/tmp/retinue/jobs/job_patch/stdout.log",
              stderrPath: "/tmp/retinue/jobs/job_patch/stderr.log",
              stdoutPreview: "Patch intent"
            },
            "RETINUE_DOGFOOD_PATCH_DONE"
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
        read_only_write_intent: 1
      }
    });
    expect(summary.failedJobs).toEqual([
      {
        task_name: "patch",
        jobId: "job_patch",
        status: "stalled",
        stallReason: "read_only_write_intent",
        stallSummary: "OpenCode read-only job emitted patch/write intent.",
        readOnlyWriteIntent: true,
        failureReason: "read_only_write_intent",
        lastAssistantAgent: "plan",
        lastAssistantMode: "plan",
        lastAssistantProviderID: "litellm",
        lastAssistantModelID: "semantic-router",
        toolCallAssistantRounds: 3,
        runningReadToolParts: 1,
        runningReadToolCallIds: ["call_read"],
        runningReadToolPartSummaries: [{ type: "tool", tool: "read", callID: "call_read", stateStatus: "running" }],
        stdoutPath: "/tmp/retinue/jobs/job_patch/stdout.log",
        stderrPath: "/tmp/retinue/jobs/job_patch/stderr.log",
        stdoutPreview: "Patch intent"
      }
    ]);
  });
});
