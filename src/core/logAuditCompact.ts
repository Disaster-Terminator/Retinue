import type { RetinueLogAuditAttention, RetinueLogAuditIssue, RetinueLogAuditResult } from "./logAudit.js";

export function renderCompactAuditResult(result: RetinueLogAuditResult): string {
  const lines = [
    [
      `Retinue log audit: issues=${result.issueCount}`,
      `attention=${result.attentionCount}`,
      `scanned=${result.scannedEvents}`,
      `ignoredCompleted=${result.ignoredCompletedJobIds.length}`,
      result.ignoredTerminalJobIds.length > 0 ? `ignoredTerminal=${result.ignoredTerminalJobIds.length}` : undefined
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
    `trace=${result.tracePath}`
  ];
  if (result.since) {
    lines.push(`since=${result.since}`);
  }
  if (result.truncatedBeforeSince) {
    lines.push(
      `warning=scan_truncated_before_since oldestScanned=${result.oldestScannedEvent ?? "unknown"} increase --max-bytes or --max-lines`
    );
  } else if (result.inputTruncated) {
    lines.push(`warning=scan_truncated oldestScanned=${result.oldestScannedEvent ?? "unknown"}`);
  }
  for (const [index, issue] of result.issues.entries()) {
    lines.push(renderCompactIssue(issue, index + 1));
  }
  for (const [index, attention] of result.attentions.entries()) {
    lines.push(renderCompactAttention(attention, index + 1));
  }
  return `${lines.join("\n")}\n`;
}

function renderCompactAttention(attention: RetinueLogAuditAttention, index: number): string {
  return renderCompactIssue(attention, index, "A");
}

function renderCompactIssue(issue: RetinueLogAuditIssue, index: number, prefix = ""): string {
  const sample = issue.sample ?? {};
  const summary = [
    `reason=${stringField(sample.problemStatus) ?? stringField(sample.stallReason) ?? "unknown"}`,
    stringField(sample.recoveryStallReason) ? `recovery=${stringField(sample.recoveryStallReason)}` : undefined,
    `provider=${providerModel(issue)}`,
    stringField(sample.baseUrl) ? `baseUrl=${stringField(sample.baseUrl)}` : undefined,
    stringField(sample.sessionDirectory) ? `cwd=${stringField(sample.sessionDirectory)}` : undefined,
    `agent=${agentMode(issue)}`,
    stringField(sample.requestedAgent) ? `requestedAgent=${stringField(sample.requestedAgent)}` : undefined,
    numericField(sample.noCompletedAssistantDurationMs) ? `durationMs=${numericField(sample.noCompletedAssistantDurationMs)}` : undefined,
    stringField(sample.selectedAttemptJobId) ? `selectedAttempt=${stringField(sample.selectedAttemptJobId)}` : undefined,
    sample.attemptChainPresent === true ? "attemptChain=true" : undefined,
    numericField(sample.malformedReadToolParts) ? `malformedRead=${numericField(sample.malformedReadToolParts)}` : undefined,
    numericField(sample.pendingPermissionCount) ? `permissions=${numericField(sample.pendingPermissionCount)}` : undefined
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const permissionLines = renderPermissionActions(sample.permissionActions);
  return [
    `#${prefix}${index} count=${issue.count} jobs=${issue.jobIds.join(",") || "none"}`,
    `  ${summary}`,
    `  title=${issue.title}`,
    `  diagnosis=${issue.description || "No diagnosis available."}`,
    ...permissionLines
  ].join("\n");
}

function renderPermissionActions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((permission, index) => {
    const parts = [
      `id=${stringField(permission.id) ?? "unknown"}`,
      `permission=${stringField(permission.permission) ?? "unknown"}`,
      stringField(permission.target) ? `target=${stringField(permission.target)}` : undefined,
      Array.isArray(permission.patterns) ? `patterns=${permission.patterns.filter((pattern) => typeof pattern === "string").join(",")}` : undefined,
      stringField(permission.toolCallID) ? `toolCall=${stringField(permission.toolCallID)}` : undefined,
      stringField(permission.recommendedReply) ? `recommended=${stringField(permission.recommendedReply)}` : undefined,
      stringField(permission.relation) ? `relation=${stringField(permission.relation)}` : undefined
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    return `  permission[${index + 1}] ${parts}`;
  });
}

function providerModel(issue: RetinueLogAuditIssue): string {
  const parts = issue.signature.split("|");
  const offset = parts[0] === "chain" ? 2 : 2;
  return `${parts[offset] ?? "unknown_provider"}/${parts[offset + 1] ?? "unknown_model"}`;
}

function agentMode(issue: RetinueLogAuditIssue): string {
  const parts = issue.signature.split("|");
  const offset = parts[0] === "chain" ? 4 : 4;
  return `${parts[offset] ?? "unknown_agent"}/${parts[offset + 1] ?? "unknown_mode"}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
