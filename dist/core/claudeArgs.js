const allowedPermissionModes = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
export function buildClaudeArgs(options) {
    const args = ["-p", "--output-format", "json"];
    if (options.resume) {
        args.push("--resume", options.resume);
    }
    if (options.maxTurns !== undefined) {
        args.push("--max-turns", String(options.maxTurns));
    }
    const permissionMode = validatePermissionMode(options.permissionMode);
    if (permissionMode) {
        args.push("--permission-mode", permissionMode);
    }
    return args;
}
function validatePermissionMode(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === "string" && allowedPermissionModes.has(value)) {
        return value;
    }
    throw new Error(`Unsupported permissionMode: ${String(value)}`);
}
//# sourceMappingURL=claudeArgs.js.map