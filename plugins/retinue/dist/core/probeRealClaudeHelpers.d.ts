export interface RealClaudeProbeOptions {
    mode: "direct" | "daemon" | "mcp-daemon";
    cwd: string;
    prompt: string;
    expected: string;
    timeoutMs: number;
    host: string;
    port: number;
    stateDir?: string;
}
export declare function parseProbeArgs(argv: string[]): RealClaudeProbeOptions;
export declare function readJsonOutput(stdout: string): Record<string, unknown>;
export declare function assertExpectedResult(result: any, expected: string): string;
