export interface DaemonDiscovery {
    url: string;
    pid: number;
    startedAt: string;
    version: string;
    token?: string;
}
export declare function writeDaemonDiscovery(stateDir: string, value: DaemonDiscovery): Promise<void>;
export declare function readDaemonDiscovery(stateDir: string): Promise<DaemonDiscovery>;
export declare function readDaemonDiscoverySync(stateDir: string): DaemonDiscovery;
export declare function validateLoopbackHttpUrl(value: unknown, label?: string): string;
