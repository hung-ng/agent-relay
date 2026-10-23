export async function requestJson(
  url,
  { method = "GET", headers = {}, body, fetchImpl = fetch, timeoutMs = 30_000, signal } = {}
) {
  const normalizedTimeoutMs = Number(timeoutMs);
  const timeoutController = Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0
    ? new AbortController()
    : null;
  let timedOut = false;
  const timer = timeoutController
    ? setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, normalizedTimeoutMs)
    : null;
  const signals = [signal, timeoutController?.signal].filter(Boolean);
  const requestSignal = signals.length > 1
    ? AbortSignal.any(signals)
    : signals[0];
  const requestHeaders = { ...headers };
  if (body !== undefined && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
    requestHeaders["content-type"] = "application/json";
  }
  try {
    const response = await fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal
    });
    let value;
    try {
      value = await response.json();
    } catch (error) {
      if (requestSignal?.aborted) throw requestSignal.reason;
      if (response.ok) throw Object.assign(new Error("response is not valid JSON", { cause: error }), { code: "EINVALIDJSON" });
      value = {};
    }
    if (!response.ok) {
      const error = new Error(value?.error ?? `request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return value;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`request timed out after ${normalizedTimeoutMs}ms`);
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
