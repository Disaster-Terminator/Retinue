import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonClientError } from "../src/daemon/client.js";

describe("DaemonClient errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves structured daemon error details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "Missing job" } }), {
        status: 404,
        statusText: "Not Found"
      })
    );

    const client = new DaemonClient("http://127.0.0.1:9999");
    const error = await client.result("job-123").catch((err) => err as DaemonClientError);

    expect(error).toBeInstanceOf(DaemonClientError);
    expect(error.message).toBe("Missing job");
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.path).toBe("/v1/jobs/result");
  });

  it("supports legacy string daemon error payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Old format message" }), {
        status: 500
      })
    );

    const client = new DaemonClient("http://127.0.0.1:9999");
    const error = await client.status("job-123").catch((err) => err as DaemonClientError);

    expect(error.message).toBe("Old format message");
    expect(error.code).toBeUndefined();
    expect(error.status).toBe(500);
    expect(error.path).toBe("/v1/jobs/status");
  });

  it("falls back to HTTP status message for malformed payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", {
        status: 502
      })
    );

    const client = new DaemonClient("http://127.0.0.1:9999");
    const error = await client.wait("job-123").catch((err) => err as DaemonClientError);

    expect(error.message).toBe("Daemon request failed with HTTP 502");
    expect(error.code).toBeUndefined();
    expect(error.status).toBe(502);
    expect(error.path).toBe("/v1/jobs/wait");
  });
});
