export function isCleanupSafeStatus(status) {
    return status === "completed" || status === "failed" || status === "killed" || status === "timed_out";
}
export function isActivePoolStatus(status) {
    return status === "running" || status === "stalled" || status === "orphaned" || status === "abandoned";
}
//# sourceMappingURL=status.js.map