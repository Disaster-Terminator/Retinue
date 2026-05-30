export declare const DEFAULT_LOG_AUDIT_MAX_BYTES: number;
export declare const DEFAULT_LOG_AUDIT_MAX_LINES = 50000;
export declare const DEFAULT_LOG_AUDIT_SINCE_MAX_BYTES: number;
export declare const DEFAULT_LOG_AUDIT_SINCE_MAX_LINES = 200000;
export interface AuditRetinueLogsOptions {
    stateDir?: string;
    tracePath?: string;
    since?: Date;
    maxBytes?: number;
    maxLines?: number;
    reconcileStatus?: (jobId: string, meta: Record<string, unknown>) => Promise<string | undefined>;
}
export interface RetinueLogAuditIssue {
    signature: string;
    title: string;
    description: string;
    count: number;
    firstSeen?: string;
    lastSeen?: string;
    jobIds: string[];
    sample?: Record<string, unknown>;
}
export interface RetinueLogAuditAttention extends RetinueLogAuditIssue {
    kind: "permission";
}
export interface RetinueLogAuditResult {
    ok: true;
    tracePath: string;
    since?: string;
    inputTruncated: boolean;
    truncatedBeforeSince: boolean;
    oldestScannedEvent?: string;
    newestScannedEvent?: string;
    scannedEvents: number;
    ignoredCompletedJobIds: string[];
    issueCount: number;
    issues: RetinueLogAuditIssue[];
    attentionCount: number;
    attentions: RetinueLogAuditAttention[];
}
export declare function auditRetinueLogs(options?: AuditRetinueLogsOptions): Promise<RetinueLogAuditResult>;
