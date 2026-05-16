import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function killProcessTree(pid, signal = "SIGTERM") {
    if (pid <= 0) {
        return;
    }
    if (process.platform === "win32") {
        try {
            await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        }
        catch {
            // Treat an already-exited process as successfully gone.
        }
        return;
    }
    try {
        process.kill(-pid, signal);
    }
    catch {
        try {
            process.kill(pid, signal);
        }
        catch {
            // Treat an already-exited process as successfully gone.
        }
    }
}
export function killProcessTreeSync(pid, signal = "SIGTERM") {
    if (pid <= 0) {
        return;
    }
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
        });
        return;
    }
    try {
        process.kill(-pid, signal);
    }
    catch {
        try {
            process.kill(pid, signal);
        }
        catch {
            // Treat an already-exited process as successfully gone.
        }
    }
}
//# sourceMappingURL=processTree.js.map