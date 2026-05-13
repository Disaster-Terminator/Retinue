import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient, OpenCodeClientError } from "../src/backends/opencode/client.js";
import { startFakeOpenCodeServer, type FakeOpenCodeServer } from "./fixtures/fake-opencode-server.js";

describe("OpenCodeClient", () => {
  let server: FakeOpenCodeServer | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("checks health, creates sessions, sends prompts, and reads messages", async () => {
    server = await startFakeOpenCodeServer({ serverCwd: "C:/server-cwd" });
    const client = new OpenCodeClient(server.url);

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });

    const session = await client.createSession({ cwd: "G:/repository/retinue", title: "test session" });
    expect(server.sessionRequests.at(-1)).toMatchObject({ directory: "G:/repository/retinue", title: "test session" });
    expect(session).toMatchObject({ id: expect.any(String), directory: "C:/server-cwd", title: "test session" });
    expect(session).not.toHaveProperty("cwd");

    await expect(client.listSessions()).resolves.toContainEqual(expect.objectContaining({ id: session.id }));
    await expect(client.getSession(session.id)).resolves.toMatchObject({ id: session.id });

    await expect(client.promptAsync(session.id, { prompt: "hello", model: "local/test", agent: "build" })).resolves.toBeUndefined();
    expect(server.promptRequests.at(-1)).toMatchObject({
      model: { providerID: "local", modelID: "test" },
      agent: "build",
      parts: [{ type: "text", text: "hello" }]
    });

    await expect(client.messages(session.id)).resolves.toContainEqual(
      expect.objectContaining({
        info: expect.objectContaining({ sessionID: session.id }),
        parts: expect.arrayContaining([expect.objectContaining({ type: "text", text: "fake result: hello" })])
      })
    );
  });

  it("aborts sessions", async () => {
    server = await startFakeOpenCodeServer();
    const client = new OpenCodeClient(server.url);
    const session = await client.createSession();

    await expect(client.abort(session.id)).resolves.toMatchObject({ ok: true });
    await expect(client.getSession(session.id)).resolves.toMatchObject({ aborted: true });
  });

  it("throws typed HTTP errors", async () => {
    server = await startFakeOpenCodeServer();
    const client = new OpenCodeClient(server.url);

    await expect(client.getSession("missing")).rejects.toMatchObject({
      name: "OpenCodeClientError",
      code: "http_error",
      status: 404,
      path: "/session/missing"
    });
    await expect(client.getSession("missing")).rejects.toBeInstanceOf(OpenCodeClientError);
  });

  it("preserves non-JSON HTTP failure bodies as HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const client = new OpenCodeClient("http://opencode");

    await expect(client.health()).rejects.toMatchObject({
      name: "OpenCodeClientError",
      code: "http_error",
      status: 503,
      path: "/global/health",
      details: "upstream unavailable"
    });
  });

  it("times out unresponsive requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );
    const client = new OpenCodeClient("http://opencode", { timeoutMs: 5 });

    await expect(client.health()).rejects.toMatchObject({
      name: "OpenCodeClientError",
      code: "transport_error",
      status: 0,
      path: "/global/health"
    });
  });
});
