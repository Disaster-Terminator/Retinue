import type { AgentBackendKind } from "../core/types.js";

export interface BackendSelectableRequest {
  backend?: unknown;
}

export function parseBackendSelection(input: BackendSelectableRequest): AgentBackendKind | undefined {
  if (input.backend === undefined) {
    return undefined;
  }
  if (input.backend === "claude-code" || input.backend === "opencode") {
    return input.backend;
  }
  throw new Error(`Unknown backend: ${String(input.backend)}`);
}
