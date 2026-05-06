import { describe, expect, it } from "vitest";
import { buildServeArgs, resolveOpenCodeServer, resolveOpenCodeServerFromEnv } from "../src/backends/opencode/serverManager.js";

describe("OpenCode server manager", () => {
  it("attaches to an explicit loopback base URL", () => {
    expect(resolveOpenCodeServer({ baseUrl: "http://127.0.0.1:4096/path" })).toEqual({
      mode: "attach",
      baseUrl: "http://127.0.0.1:4096"
    });
  });

  it("rejects missing server target unless auto-serve is enabled", () => {
    expect(() => resolveOpenCodeServer({ autoServe: false })).toThrow("OpenCode server target missing");
  });

  it("builds explicit opencode serve args", () => {
    expect(buildServeArgs({ host: "127.0.0.1", port: 0 })).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  it("resolves opt-in serve from env", () => {
    expect(
      resolveOpenCodeServerFromEnv({
        SUPERVISOR_OPENCODE_AUTO_SERVE: "1",
        SUPERVISOR_OPENCODE_COMMAND: "opencode-test",
        SUPERVISOR_OPENCODE_HOST: "127.0.0.1",
        SUPERVISOR_OPENCODE_PORT: "4096"
      })
    ).toEqual({
      mode: "serve",
      command: "opencode-test",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
      host: "127.0.0.1",
      port: 4096
    });
  });

  it("rejects non-loopback and non-http base URLs", () => {
    expect(() => resolveOpenCodeServer({ baseUrl: "https://127.0.0.1:4096" })).toThrow("must use http");
    expect(() => resolveOpenCodeServer({ baseUrl: "http://example.com:4096" })).toThrow("must be loopback");
  });
});
