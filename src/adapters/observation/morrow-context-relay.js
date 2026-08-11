/**
 * Same-host Cyberboss -> Morrow relay for one fresh Accessibility read.
 *
 * This endpoint is intentionally loopback-only on the Morrow side. The
 * authenticated Clawd SSE then carries the request to the Android companion,
 * which posts the filtered/unfiltered result back to Morrow.
 */
function createMorrowContextRelay(config) {
  const baseUrl = String(config.morrowBaseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");

  async function requestContext({ requestId, timeoutMs = 15_000 } = {}) {
    if (!requestId) {
      throw new Error("morrow-context-relay: requestContext requires a requestId");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/api/internal/clawd/context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Morrow-Request": "1",
          "X-Morrow-Internal": "1",
        },
        body: JSON.stringify({ requestId }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) {
        throw new Error(body.error || `Morrow context relay HTTP ${response.status}`);
      }
      return {
        created_at: new Date().toISOString(),
        detail: body,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Morrow context relay timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { requestContext };
}

module.exports = { createMorrowContextRelay };
