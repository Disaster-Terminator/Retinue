import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Treat an already-exited process as successfully gone.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Treat an already-exited process as successfully gone.
    }
  }
}

