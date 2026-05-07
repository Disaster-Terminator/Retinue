import http from "node:http";
import type { ClaudeSupervisor } from "../core/supervisor.js";
export interface DaemonServerOptions {
    maxBodyBytes?: number;
}
export declare function createDaemonServer(supervisor: ClaudeSupervisor, options?: DaemonServerOptions): http.Server;
