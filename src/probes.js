import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_REPORT_DEPTH = 128;

const timeoutPromise = (promise, timeoutMs, onTimeout, signal) => {
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => {
    onAbort = () => {
      try { onTimeout?.(); } catch { /* Cancellation must still reject the check. */ }
      reject(signal.reason);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* The timeout still needs to reject the check. */ }
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
};

const elapsed = (start) => Math.round((performance.now() - start) * 100) / 100;

export async function runProbe(payload, { signal } = {}) {
  signal?.throwIfAborted();
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  if (checks.length === 0) throw new Error("network.probe requires at least one check");
  const timeoutMs = normalizeTimeout(payload.timeout_ms);
  const report = { source_host: null, target_host: null, ok: true, checks: [] };
  const counts = { truncated: true, total_checks: checks.length, completed_checks: checks.length, omitted_checks: checks.length };
  const omittedFields = [];
  // Reserve the largest summary before retaining any detail, including host fields.
  let remainingBytes = MAX_REPORT_BYTES - jsonBytes({ ...report, ok: false, ...counts, omitted_fields: ["source_host", "target_host"] }, MAX_REPORT_BYTES);
  for (const field of ["source_host", "target_host"]) {
    const value = payload[field] ?? null;
    const bytes = jsonBytes(value, remainingBytes + 4);
    if (bytes > remainingBytes + 4) omittedFields.push(field);
    else {
      report[field] = value;
      remainingBytes -= bytes - 4;
    }
  }
  let completed = 0;
  let retainDetails = true;
  for (const check of checks) {
    if (completed > 0 && completed % 128 === 0) await yieldToEventLoop();
    signal?.throwIfAborted();
    const started = performance.now();
    let detail;
    try {
      const result = await runCheck(check, timeoutMs, signal, retainDetails ? remainingBytes : 0);
      signal?.throwIfAborted();
      if (retainDetails && result) detail = { ...result, ok: true, duration_ms: elapsed(started) };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      report.ok = false;
      if (retainDetails) detail = { type: check?.type ?? "invalid", ok: false, error: error?.message ?? String(error), duration_ms: elapsed(started) };
    }
    completed += 1;
    if (retainDetails) {
      const separatorBytes = report.checks.length > 0 ? 1 : 0;
      const bytes = detail ? jsonBytes(detail, remainingBytes - separatorBytes) : remainingBytes + 1;
      if (bytes + separatorBytes > remainingBytes) retainDetails = false;
      else {
        report.checks.push(detail);
        remainingBytes -= bytes + separatorBytes;
      }
    }
  }
  if (!retainDetails || omittedFields.length > 0) {
    Object.assign(report, counts, { completed_checks: completed, omitted_checks: completed - report.checks.length });
    if (omittedFields.length > 0) report.omitted_fields = omittedFields;
  }
  return report;
}

async function runCheck(check, timeoutMs, signal, detailBytes) {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    throw new Error("probe check must be an object");
  }
  switch (check.type) {
    case "dns": {
      const addresses = await timeoutPromise(dns.lookup(check.name, { all: true }), timeoutMs, null, signal);
      return detailBytes > 0 ? { type: "dns", name: check.name, addresses } : null;
    }
    case "tcp": {
      await connectTcp(check.host, check.port, timeoutMs, signal);
      return detailBytes > 0 ? { type: "tcp", host: check.host, port: check.port } : null;
    }
    case "http": {
      const controller = new AbortController();
      const response = await timeoutPromise(
        fetch(check.url, { redirect: "manual", signal: controller.signal }),
        timeoutMs,
        () => controller.abort(),
        signal
      );
      try {
        return detailBytes > 0 ? httpDetail(check, response, detailBytes) : null;
      } finally {
        try {
          await timeoutPromise(Promise.resolve(response.body?.cancel?.()), timeoutMs, () => controller.abort(), signal);
        } catch {
          signal?.throwIfAborted();
          // The response may already be closed, or its cancellation may have timed out.
        }
      }
    }
    case "tls": {
      const result = await connectTls(check.host, check.port, check.servername, timeoutMs, signal);
      return detailBytes > 0 ? { type: "tls", host: check.host, port: check.port, protocol: result.protocol, authorized: result.authorized } : null;
    }
    default:
      throw new Error(`unsupported probe type: ${check.type}`);
  }
}

function httpDetail(check, response, budget) {
  const result = { type: "http", url: check.url, status: response.status, headers: {} };
  let remaining = budget - jsonBytes(result, budget);
  if (remaining < 0) return null;
  let count = 0;
  for (const [name, value] of response.headers) {
    const key = String(name);
    const keyBytes = jsonStringBytes(key, remaining);
    const separatorBytes = count > 0 ? 1 : 0;
    const bytes = keyBytes + 1 + separatorBytes + jsonBytes(value, remaining - keyBytes - 1 - separatorBytes);
    if (bytes > remaining) return null;
    Object.defineProperty(result.headers, key, { value, enumerable: true, writable: true, configurable: true });
    remaining -= bytes;
    count += 1;
  }
  return result;
}

// Count JSON syntax and UTF-8 bytes without encoding an unbounded string or copying fields.
function jsonBytes(value, limit) {
  if (limit < 0) return Infinity;
  let bytes = 0;
  const ancestors = new Set();
  const stack = [{ value }];
  while (stack.length > 0 && bytes <= limit) {
    const frame = stack[stack.length - 1];
    if (frame.iterator) {
      const next = frame.iterator.next();
      if (next.done) {
        ancestors.delete(frame.value);
        stack.pop();
        continue;
      }
      const [key, entry] = next.value;
      const type = typeof entry;
      if (!frame.array && (entry === undefined || type === "function" || type === "symbol")) continue;
      if (frame.count++ > 0) bytes += 1;
      if (!frame.array) bytes += jsonStringBytes(key, limit - bytes) + 1;
      if (bytes <= limit) stack.push({ value: entry });
      continue;
    }
    stack.pop();
    const entry = frame.value;
    if (entry === null || entry === undefined || typeof entry === "function" || typeof entry === "symbol") bytes += 4;
    else if (typeof entry === "string") bytes += jsonStringBytes(entry, limit - bytes);
    else if (typeof entry === "boolean") bytes += entry ? 4 : 5;
    else if (typeof entry === "number") bytes += Number.isFinite(entry) ? String(entry).length : 4;
    else if (typeof entry === "object") {
      // Keep malformed nested fields safe for the report's eventual JSON.stringify.
      if (ancestors.size >= MAX_REPORT_DEPTH || ancestors.has(entry) || typeof entry.toJSON === "function") return Infinity;
      bytes += 2;
      ancestors.add(entry);
      stack.push({ value: entry, iterator: jsonEntries(entry), array: Array.isArray(entry), count: 0 });
    } else return Infinity;
  }
  return bytes <= limit ? bytes : Infinity;
}

function* jsonEntries(value) {
  if (Array.isArray(value)) {
    for (const entry of value) yield [null, entry];
  } else {
    for (const key in value) if (Object.hasOwn(value, key)) yield [key, value[key]];
  }
}

function jsonStringBytes(value, limit) {
  if (value.length + 2 > limit) return Infinity;
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return Infinity;
  }
  return bytes;
}

function connectTcp(host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason);
    socket.once("connect", () => finish());
    socket.once("error", finish);
    socket.setTimeout(timeoutMs, () => finish(new Error(`timed out after ${timeoutMs}ms`)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function connectTls(host, port, servername = host, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port), servername, rejectUnauthorized: false });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const details = error ? null : { protocol: socket.getProtocol(), authorized: socket.authorized };
      socket.destroy();
      if (error) reject(error);
      else resolve(details);
    };
    const onAbort = () => finish(signal.reason);
    socket.once("secureConnect", () => finish());
    socket.once("error", finish);
    socket.setTimeout(timeoutMs, () => finish(new Error(`timed out after ${timeoutMs}ms`)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_TIMEOUT_MS);
}
