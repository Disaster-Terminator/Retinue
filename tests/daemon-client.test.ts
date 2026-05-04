import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonClientError } from "../src/daemon/client.js";

describe("DaemonClient errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves structured daemon error details", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "Missing job" } }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_123")).rejects.toMatchObject({
      name: "DaemonClientError",
      message: "Missing job",
      code: "not_found",
      status: 404,
      path: "/v1/jobs/status"
    });
  });

  it("supports legacy string error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Legacy fail" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_legacy")).rejects.toMatchObject({
      message: "Legacy fail",
      code: undefined,
      status: 400,
      path: "/v1/jobs/status"
    });
  });

  it("falls back to generic HTTP message for empty or malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", { status: 502 })));

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_bad")).rejects.toEqual(
      expect.objectContaining({
        message: "Daemon request failed with HTTP 502",
        code: undefined,
        status: 502,
        path: "/v1/jobs/status"
      })
    );
  });

  it("throws typed daemon client errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_any")).rejects.toBeInstanceOf(DaemonClientError);
  });
});
