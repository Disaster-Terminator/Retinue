import { afterEach, describe, expect, it, vi } from "vitest";

describe("OpenCodeClient SDK error handling", () => {
  afterEach(() => {
    vi.doUnmock("@opencode-ai/sdk/v2/client");
    vi.resetModules();
  });

  it("preserves SDK errors that do not include a response object", async () => {
    vi.doMock("@opencode-ai/sdk/v2/client", () => ({
      createOpencodeClient: () => ({
        global: {
          health: async () => ({
            data: undefined,
            error: { message: "provider produced incomplete assistant round" },
            request: new Request("http://opencode/global/health"),
            response: undefined
          })
        }
      })
    }));

    const { OpenCodeClient, OpenCodeClientError } = await import("../src/backends/opencode/client.js");
    const client = new OpenCodeClient("http://opencode");

    await expect(client.health()).rejects.toMatchObject({
      name: "OpenCodeClientError",
      code: "transport_error",
      status: 0,
      path: "/global/health",
      message: "provider produced incomplete assistant round"
    });
    await expect(client.health()).rejects.toBeInstanceOf(OpenCodeClientError);
  });
});
