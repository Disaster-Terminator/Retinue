import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessTreeSync } from "../src/core/processTree.js";

describe("process tree helpers", () => {
  it("synchronously treats an already-exited process as gone", () => {
    expect(() => killProcessTreeSync(99999999)).not.toThrow();
  });

  it("can synchronously stop a live child process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32"
    });

    try {
      expect(child.pid).toBeTypeOf("number");
      killProcessTreeSync(child.pid ?? -1);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child process did not exit after killProcessTreeSync")), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (child.pid && child.exitCode === null) {
        killProcessTreeSync(child.pid);
      }
    }
  });
});
