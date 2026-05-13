#!/usr/bin/env node
export declare function assertDaemonHostAllowed(host: string, env?: Partial<Record<"RETINUE_DAEMON_ALLOW_NON_LOOPBACK", string | undefined>>): void;
export interface DaemonReadyPayload {
    status: "listening";
    host: string;
    port: number;
    url: string;
    pid: number;
    startedAt: string;
    version: string;
}
export declare function buildDaemonReadyPayload(options: {
    host: string;
    port: number;
    pid: number;
    startedAt: string;
    version: string;
}): DaemonReadyPayload;
