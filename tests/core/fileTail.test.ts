import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTextTailIfExists } from "../../src/core/fileTail.js";

describe("readTextTailIfExists", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "retinue-tail-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads only a bounded suffix and reports the full file size", async () => {
    const filePath = path.join(tempDir, "stdout.log");
    await fs.writeFile(filePath, `${"x".repeat(128)}\nready-é-tail`, "utf8");
    const readFile = vi.spyOn(fs, "readFile");

    const tail = await readTextTailIfExists(filePath, 10);

    expect(readFile).not.toHaveBeenCalled();
    expect(tail.text).toBe("dy-é-tail");
    expect(tail.bytes).toBe(Buffer.byteLength(`${"x".repeat(128)}\nready-é-tail`, "utf8"));
    expect(tail.truncated).toBe(true);
    expect(tail.text).not.toContain("\uFFFD");
  });

  it("returns an empty tail for missing files", async () => {
    await expect(readTextTailIfExists(path.join(tempDir, "missing.log"), 32)).resolves.toEqual({
      text: "",
      bytes: 0,
      truncated: false
    });
  });
});
