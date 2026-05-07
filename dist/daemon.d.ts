#!/usr/bin/env node
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
