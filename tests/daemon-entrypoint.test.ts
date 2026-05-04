import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("daemon package entrypoint", () => {
  it("exposes supervisor-daemon as a package binary", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));

    expect(packageJson.bin["supervisor-daemon"]).toBe("./dist/daemon.js");
  });
});
