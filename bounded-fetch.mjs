// Race the deadline so a fetch that never settles still returns.
export async function withTimeout(timeoutMs, run) {
  const controller = new AbortController();
  let rejectAbort;
  const abortPromise = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error("request timed out after " + timeoutMs + "ms");
    error.name = "TimeoutError";
    controller.abort(error);
    rejectAbort(error);
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const task = Promise.resolve().then(() => run(controller.signal));
  task.catch(() => {});
  try {
    return await Promise.race([task, abortPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function releaseBody(response) {
  const cancel = response && response.body && response.body.cancel;
  if (typeof cancel !== "function") return;
  try {
    await response.body.cancel();
  } catch {
    // The caller is already leaving this response behind.
  }
}

export async function fetchBounded(url, timeoutMs = 20000, fetchImpl = fetch, extra = {}) {
  const options = extra.options || {};
  const read = extra.read || "json";
  const impl = fetchImpl || fetch;
  return withTimeout(timeoutMs, async (signal) => {
    const response = await impl(url, { ...options, signal });
    if (!response || !response.ok) {
      await releaseBody(response);
      return { ok: false, status: response && response.status, data: null };
    }
    let data = null;
    if (read === "text") data = await response.text();
    else if (read === "buffer") data = await response.arrayBuffer();
    else if (read !== "none") data = await response.json();
    else await releaseBody(response);
    return { ok: true, status: response.status, data };
  });
}
