import fs from "node:fs/promises";

export interface TextTail {
  text: string;
  bytes: number;
  truncated: boolean;
}

export const MAX_TEXT_TAIL_BYTES = 1024 * 1024;

export async function readTextTailIfExists(filePath: string, maxBytes: number): Promise<TextTail> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return { text: "", bytes: Math.max(0, stats.size), truncated: false };
    }

    const requestedBytes = Math.min(MAX_TEXT_TAIL_BYTES, Math.max(0, Math.floor(maxBytes)));
    if (requestedBytes <= 0) {
      return { text: "", bytes: stats.size, truncated: true };
    }

    const readBytes = Math.min(stats.size, requestedBytes + 3);
    const buffer = Buffer.alloc(readBytes);
    const handle = await fs.open(filePath, "r");
    try {
      await handle.read(buffer, 0, readBytes, stats.size - readBytes);
    } finally {
      await handle.close();
    }

    const decoded = trimLeadingReplacementCharacters(buffer.toString("utf8"));
    const limited = limitUtf8Suffix(decoded, requestedBytes);
    return {
      text: limited.text,
      bytes: stats.size,
      truncated: stats.size > Buffer.byteLength(limited.text, "utf8")
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { text: "", bytes: 0, truncated: false };
    }
    throw error;
  }
}

export function limitUtf8Suffix(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }

  const chars = Array.from(text);
  const suffix: string[] = [];
  let usedBytes = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    suffix.push(char);
    usedBytes += charBytes;
  }
  return { text: suffix.reverse().join(""), truncated: true };
}

function trimLeadingReplacementCharacters(text: string): string {
  return text.replace(/^\uFFFD+/, "");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
