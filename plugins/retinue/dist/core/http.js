const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export function resolveHttpTimeoutMs(env = process.env) {
    const value = env.RETINUE_HTTP_TIMEOUT_MS;
    if (!value?.trim()) {
        return DEFAULT_HTTP_TIMEOUT_MS;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_HTTP_TIMEOUT_MS;
}
export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
    if (timeoutMs <= 0) {
        return fetch(url, init);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: init.signal ?? controller.signal
        });
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=http.js.map