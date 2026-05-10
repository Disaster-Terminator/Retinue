import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import { ClaudeRetinue } from "../src/core/retinue.js";
import type { RetinueApi } from "../src/core/types.js";

describe("RetinueApi", () => {
  it("is implemented by the direct core retinue and daemon client", () => {
    const direct: RetinueApi = new ClaudeRetinue({ stateDir: "unused" });
    const daemon: RetinueApi = new DaemonClient("http://127.0.0.1:27777");

    expect(typeof direct.run).toBe("function");
    expect(typeof daemon.run).toBe("function");
  });
});
