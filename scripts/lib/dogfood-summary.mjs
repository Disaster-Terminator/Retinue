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
      readOnlyWriteIntent: wait.readOnlyWriteIntent,
      failureReason: wait.failureReason,
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
  return undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string") ?? "";
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
