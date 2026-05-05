import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import { ClaudeSupervisor } from "../src/core/supervisor.js";
import type { SupervisorApi } from "../src/core/types.js";

describe("SupervisorApi", () => {
  it("is implemented by the direct core supervisor and daemon client", () => {
    const direct: SupervisorApi = new ClaudeSupervisor({ stateDir: "unused" });
    const daemon: SupervisorApi = new DaemonClient("http://127.0.0.1:27777");

    expect(typeof direct.run).toBe("function");
    expect(typeof daemon.run).toBe("function");
  });
});
