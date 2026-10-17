export async function requestJson(url, { method = "GET", headers = {}, body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error ?? `request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return value;
}
