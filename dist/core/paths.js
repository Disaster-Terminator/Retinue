import path from "node:path";
import os from "node:os";
export function resolveStateDir(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? os.homedir();
    if (options.explicitStateDir) {
        return path.normalize(options.explicitStateDir);
    }
    if (env.SUPERVISOR_STATE_DIR) {
        return path.normalize(env.SUPERVISOR_STATE_DIR);
    }
    if (platform === "win32" && env.LOCALAPPDATA) {
        return path.join(env.LOCALAPPDATA, "supervisor");
    }
    if (env.XDG_STATE_HOME) {
        return path.join(env.XDG_STATE_HOME, "supervisor");
    }
    return path.join(homeDir, ".local", "state", "supervisor");
}
export function getJobPaths(stateDir, jobId) {
    const dir = path.join(stateDir, "jobs", jobId);
    return {
        dir,
        meta: path.join(dir, "meta.json"),
        stdout: path.join(dir, "stdout.log"),
        stderr: path.join(dir, "stderr.log"),
        exitStatus: path.join(dir, "exit-status.json"),
        prompt: path.join(dir, "prompt.md")
    };
}
export function getDaemonDiscoveryPath(stateDir) {
    return path.join(stateDir, "daemon.json");
}
//# sourceMappingURL=paths.js.map