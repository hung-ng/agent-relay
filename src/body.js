export const MAX_JSON_BYTES = 1_048_576;

export async function readJsonBody(request, { maxBytes = MAX_JSON_BYTES } = {}) {
  const declaredLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw bodyError(`request body exceeds ${maxBytes} bytes`, 413);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw bodyError(`request body exceeds ${maxBytes} bytes`, 413);
    chunks.push(chunk);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw bodyError("request body must contain valid UTF-8", 400);
  }
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw bodyError("request body must be valid JSON", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bodyError("request body must be a JSON object", 400);
  }
  return value;
}

function bodyError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
