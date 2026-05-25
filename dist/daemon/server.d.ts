import http from "node:http";
import type { ClaudeRetinue } from "../core/retinue.js";
export interface DaemonServerOptions {
    maxBodyBytes?: number;
    authToken?: string;
    allowUnauthenticated?: boolean;
}
export declare function createDaemonServer(retinue: ClaudeRetinue, options?: DaemonServerOptions): http.Server;
