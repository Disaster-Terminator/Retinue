import http from "node:http";
import type { ClaudeRetinue } from "../core/retinue.js";
export interface DaemonServerOptions {
    maxBodyBytes?: number;
}
export declare function createDaemonServer(retinue: ClaudeRetinue, options?: DaemonServerOptions): http.Server;
