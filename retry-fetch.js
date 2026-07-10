(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function methodOf(input, init) {
    return String(
      init?.method ||
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
  }

  function urlOf(input) {
    return input instanceof Request ? input.url : String(input);
  }

  function headerOf(input, init, name) {
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined)
    );
    return headers.get(name);
  }

  function canRetry(input, init) {
    const method = methodOf(input, init);
    const url = urlOf(input);

    if (["GET", "HEAD", "OPTIONS", "DELETE", "PUT", "PATCH"].includes(method)) {
      return true;
    }

    // Auth token operations and password updates are safe to repeat.
    if (url.includes("/auth/v1/token") || url.includes("/auth/v1/user")) {
      return true;
    }

    // This application uses only a read-only RPC.
    if (url.includes("/rest/v1/rpc/get_vote_progress")) {
      return true;
    }

    // Supabase upsert with merge-duplicates is idempotent.
    const prefer = (headerOf(input, init, "Prefer") || "").toLowerCase();
    if (method === "POST" && prefer.includes("resolution=merge-duplicates")) {
      return true;
    }

    // Plain INSERT requests are deliberately not retried to avoid duplicates.
    return false;
  }

  function retryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
  }

  function attemptSignal(originalSignal, timeoutMs) {
    const controller = new AbortController();
    let timeoutTriggered = false;

    const timeoutId = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);

    const propagateAbort = () => controller.abort(originalSignal?.reason);

    if (originalSignal) {
      if (originalSignal.aborted) {
        propagateAbort();
      } else {
        originalSignal.addEventListener("abort", propagateAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      timeoutTriggered: () => timeoutTriggered,
      cleanup() {
        clearTimeout(timeoutId);
        originalSignal?.removeEventListener?.("abort", propagateAbort);
      }
    };
  }

  window.createResilientFetch = function createResilientFetch(options = {}) {
    const retries = Number.isInteger(options.retries) ? options.retries : 3;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 700;

    return async function resilientFetch(input, init = {}) {
      const retryAllowed = canRetry(input, init);
      const attempts = retryAllowed ? retries + 1 : 1;
      let lastError = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const signalState = attemptSignal(init.signal, timeoutMs);

        try {
          const response = await nativeFetch(input, {
            ...init,
            signal: signalState.signal
          });

          if (!retryableStatus(response.status) || attempt === attempts - 1) {
            return response;
          }

          lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
          lastError = error;

          if (init.signal?.aborted) {
            throw error;
          }

          if (attempt === attempts - 1) {
            throw error;
          }
        } finally {
          signalState.cleanup();
        }

        const exponentialDelay = baseDelayMs * (2 ** attempt);
        const jitter = Math.floor(Math.random() * 300);
        await sleep(Math.min(exponentialDelay + jitter, 10000));
      }

      throw lastError || new Error("Request failed");
    };
  };
})();
