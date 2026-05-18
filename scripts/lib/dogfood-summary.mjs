export function classifyDogfoodWait(wait, expectedMarker) {
  const status = wait?.status ?? "unknown";
  const stallReason = wait?.stallReason ?? wait?.diagnostic?.stallReason;
  const readOnlyWriteIntent = wait?.readOnlyWriteIntent === true || wait?.diagnostic?.readOnlyWriteIntent === true;
  const stdoutText = firstString(wait?.stdoutText, wait?.stdout, wait?.stdoutPreview);
  const stdoutPreview = typeof wait?.stdoutPreview === "string" ? wait.stdoutPreview : "";
  const providerError = classifyProviderError({ stallReason, stdoutText });
  const failureReason = selectFailureReason({ status, stallReason, readOnlyWriteIntent, stdoutText, expectedMarker, providerError });
  const { stdoutText: _stdoutText, stdout: _stdout, ...publicWait } = wait ?? {};

  return {
    ...publicWait,
    expectedMarker,
    usable: failureReason === undefined,
    failureReason,
    ...(providerError
      ? {
          providerErrorKind: providerError.kind,
          providerErrorHint: providerError.hint
        }
      : {})
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
      providerErrorKind: wait.providerErrorKind,
      providerErrorHint: wait.providerErrorHint,
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

function selectFailureReason({ status, stallReason, readOnlyWriteIntent, stdoutText, expectedMarker, providerError }) {
  if (readOnlyWriteIntent) {
    return "read_only_write_intent";
  }
  if (providerError) {
    return `provider_error:${providerError.kind}`;
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

function classifyProviderError({ stallReason, stdoutText }) {
  if (stallReason !== "provider_error") {
    return undefined;
  }
  if (/reasoning_content.*thinking mode must be passed back to the API/is.test(stdoutText)) {
    return {
      kind: "deepseek_reasoning_content",
      hint: "Deepseek thinking-mode routing requires reasoning_content continuity; check LiteLLM/OpenCode router configuration."
    };
  }
  if (/\b(?:401|unauthorized|invalid[_ -]?api[_ -]?key|authentication)\b/i.test(stdoutText)) {
    return {
      kind: "auth",
      hint: "Provider authentication failed; check the active OpenCode/LiteLLM credentials before retrying Retinue."
    };
  }
  if (/\b(?:429|rate limit|quota|insufficient_quota)\b/i.test(stdoutText)) {
    return {
      kind: "rate_limit",
      hint: "Provider quota or rate limits blocked the child; retry later or change the backend route."
    };
  }
  return {
    kind: "generic",
    hint: "OpenCode provider or router failed before final text; inspect provider logs and route configuration."
  };
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
