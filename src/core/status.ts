import type { JobStatus } from "./types.js";

export function isCleanupSafeStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "timed_out";
}

export function isActivePoolStatus(status: JobStatus): boolean {
  return status === "running" || status === "orphaned" || status === "abandoned";
}
