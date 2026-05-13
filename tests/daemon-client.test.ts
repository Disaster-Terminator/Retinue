import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonClientError } from "../src/daemon/client.js";

describe("DaemonClient errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves structured daemon error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "Missing job" } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
      )
    );

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

    await expect(client.status("job_bad")).rejects.toMatchObject({
      message: "Daemon request failed with HTTP 502",
      code: undefined,
      status: 502,
      path: "/v1/jobs/status",
      details: "{"
    });
  });

  it("rejects successful responses with invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", { status: 200 })));

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_bad_json")).rejects.toMatchObject({
      name: "DaemonClientError",
      message: "Daemon response was not valid JSON",
      code: "invalid_json",
      status: 200,
      path: "/v1/jobs/status",
      details: "{"
    });
  });

  it("throws typed daemon client errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_any")).rejects.toBeInstanceOf(DaemonClientError);
  });

  it("classifies unreachable daemon transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_down")).rejects.toMatchObject({
      name: "DaemonClientError",
      message: "Unable to reach daemon",
      code: "transport_unreachable",
      status: 0,
      path: "/v1/jobs/status"
    });
  });

  it("classifies aborted transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("The operation was aborted", "AbortError")))
    );

    const client = new DaemonClient("http://daemon");

    await expect(client.status("job_abort")).rejects.toMatchObject({
      name: "DaemonClientError",
      message: "Daemon request timed out or was aborted",
      code: "transport_aborted",
      status: 0,
      path: "/v1/jobs/status"
    });
  });

  it("times out unresponsive daemon requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );

    const client = new DaemonClient("http://daemon", { timeoutMs: 5 });

    await expect(client.status("job_slow")).rejects.toMatchObject({
      name: "DaemonClientError",
      message: "Daemon request timed out or was aborted",
      code: "transport_aborted",
      status: 0,
      path: "/v1/jobs/status"
    });
  });
});
