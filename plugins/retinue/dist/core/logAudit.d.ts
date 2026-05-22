export declare const DEFAULT_LOG_AUDIT_MAX_BYTES: number;
export declare const DEFAULT_LOG_AUDIT_MAX_LINES = 500;
export interface AuditRetinueLogsOptions {
    stateDir?: string;
    tracePath?: string;
    since?: Date;
    maxBytes?: number;
    maxLines?: number;
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
export interface RetinueLogAuditResult {
    ok: true;
    tracePath: string;
    since?: string;
    scannedEvents: number;
    ignoredCompletedJobIds: string[];
    issueCount: number;
    issues: RetinueLogAuditIssue[];
}
export declare function auditRetinueLogs(options?: AuditRetinueLogsOptions): Promise<RetinueLogAuditResult>;
