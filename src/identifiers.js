import { randomUUID } from "node:crypto";

export const MAX_ENCODED_ID_LENGTH = 4096;
export const MAX_ENCODED_REPLY_ID_LENGTH = MAX_ENCODED_ID_LENGTH + encodeURIComponent("reply:").length;

export function validateIdentifier(value, field) {
  if (typeof value !== "string") throw identifierError(field, "must be a string");
  if (value.includes("\0") || !value.isWellFormed()) {
    throw identifierError(field, "must not contain NUL or unpaired surrogates");
  }
  return value;
}

export function validateRecordId(value, field, maxEncodedLength = MAX_ENCODED_ID_LENGTH) {
  if (typeof value !== "string" || !value.trim()) throw identifierError(field, "must be a non-empty string");
  validateIdentifier(value, field);
  if (value === "." || value === "..") {
    throw identifierError(field, "must not be a dot path segment");
  }
  if (encodeURIComponent(value).length > maxEncodedLength) {
    throw identifierError(field, `must fit within ${maxEncodedLength} encoded URI-component characters`);
  }
  return value;
}

export function normalizeRecordId(value, field, maxEncodedLength = MAX_ENCODED_ID_LENGTH) {
  if (value === undefined || value === null) return randomUUID();
  return validateRecordId(String(value).trim(), field, maxEncodedLength);
}

export function validateAgentId(value, field = "agent id") {
  validateRecordId(value, field);
  if (/[\u0000-\u001f\u007f\u0100-\uffff]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    throw identifierError(field, "must roundtrip X-Agent-ID without whitespace changes, controls, or non-Latin-1 characters");
  }
  return value;
}

function identifierError(field, reason) {
  return Object.assign(new Error(`${field} ${reason}`), { status: 400 });
}
