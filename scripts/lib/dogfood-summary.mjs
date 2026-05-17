export function classifyDogfoodWait(wait, expectedMarker) {
  const status = wait?.status ?? "unknown";
  const stallReason = wait?.stallReason ?? wait?.diagnostic?.stallReason;
  const readOnlyWriteIntent = wait?.readOnlyWriteIntent === true || wait?.diagnostic?.readOnlyWriteIntent === true;
  const stdoutText = firstString(wait?.stdoutText, wait?.stdout, wait?.stdoutPreview);
  const stdoutPreview = typeof wait?.stdoutPreview === "string" ? wait.stdoutPreview : "";
  const failureReason = selectFailureReason({ status, stallReason, readOnlyWriteIntent, stdoutText, expectedMarker });
  const { stdoutText: _stdoutText, stdout: _stdout, ...publicWait } = wait ?? {};

  return {
    ...publicWait,
    expectedMarker,
    usable: failureReason === undefined,
    failureReason
  };
}

export function summarizeDogfoodResults(agentResults) {
  const waits = agentResults.flatMap((result) => result.waits ?? []);
  const failures = waits.filter((wait) => wait.usable !== true);
  return {
    ok: failures.length === 0,
    completed: waits.filter((wait) => wait.status === "completed").length,
    stalled: waits.filter((wait) => wait.status === "stalled").length,
    running: waits.filter((wait) => wait.status === "running").length,
    failed: failures.length,
    failureReasons: countBy(failures.map((wait) => wait.failureReason ?? "unknown")),
    failedJobs: failures.map((wait) => ({
      task_name: wait.task_name,
      jobId: wait.jobId,
      status: wait.status,
      stallReason: wait.stallReason,
      stallSummary: wait.stallSummary,
      readOnlyWriteIntent: wait.readOnlyWriteIntent,
      failureReason: wait.failureReason,
      lastAssistantAgent: wait.lastAssistantAgent,
      lastAssistantMode: wait.lastAssistantMode,
      lastAssistantProviderID: wait.lastAssistantProviderID,
      lastAssistantModelID: wait.lastAssistantModelID,
      toolCallAssistantRounds: wait.toolCallAssistantRounds,
      runningReadToolParts: wait.runningReadToolParts,
      runningReadToolCallIds: wait.runningReadToolCallIds,
      runningReadToolPartSummaries: wait.runningReadToolPartSummaries,
      stdoutPath: wait.stdoutPath,
      stderrPath: wait.stderrPath,
      stdoutPreview: wait.stdoutPreview
    }))
  };
}

function selectFailureReason({ status, stallReason, readOnlyWriteIntent, stdoutText, expectedMarker }) {
  if (readOnlyWriteIntent) {
    return "read_only_write_intent";
  }
  if (status !== "completed") {
    return stallReason ?? status;
  }
  if (expectedMarker && !stdoutText.includes(expectedMarker)) {
    return "missing_completion_marker";
  }
  const verdict = extractDogfoodVerdict(stdoutText, expectedMarker);
  if (verdict === "fail") {
    return "child_reported_fail";
  }
  if (verdict === "missing") {
    return "missing_pass_verdict";
  }
  return undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string") ?? "";
}

function extractDogfoodVerdict(stdoutText, expectedMarker) {
  const markerIndex = expectedMarker ? stdoutText.indexOf(expectedMarker) : -1;
  const verdictWindow = stdoutText.slice(0, markerIndex >= 0 ? markerIndex : Math.min(stdoutText.length, 1200));
  if (/\bFAIL\b/i.test(verdictWindow)) {
    return "fail";
  }
  if (/\bPASS\b/i.test(verdictWindow)) {
    return "pass";
  }
  return "missing";
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
