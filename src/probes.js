import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;

const timeoutPromise = (promise, timeoutMs, onTimeout) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* The timeout still needs to reject the check. */ }
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const elapsed = (start) => Math.round((performance.now() - start) * 100) / 100;

export async function runProbe(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  if (checks.length === 0) throw new Error("network.probe requires at least one check");
  const timeoutMs = normalizeTimeout(payload.timeout_ms);
  const results = [];
  for (const check of checks) {
    const started = performance.now();
    try {
      const result = await runCheck(check, timeoutMs);
      results.push({ ...result, ok: true, duration_ms: elapsed(started) });
    } catch (error) {
      results.push({ type: check?.type ?? "invalid", ok: false, error: error.message, duration_ms: elapsed(started) });
    }
  }
  return {
    source_host: payload.source_host ?? null,
    target_host: payload.target_host ?? null,
    ok: results.every((result) => result.ok),
    checks: results
  };
}

async function runCheck(check, timeoutMs) {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    throw new Error("probe check must be an object");
  }
  switch (check.type) {
    case "dns": {
      const addresses = await timeoutPromise(dns.lookup(check.name, { all: true }), timeoutMs);
      return { type: "dns", name: check.name, addresses };
    }
    case "tcp": {
      await connectTcp(check.host, check.port, timeoutMs);
      return { type: "tcp", host: check.host, port: check.port };
    }
    case "http": {
      const controller = new AbortController();
      const response = await timeoutPromise(
        fetch(check.url, { redirect: "manual", signal: controller.signal }),
        timeoutMs,
        () => controller.abort()
      );
      const result = { type: "http", url: check.url, status: response.status, headers: Object.fromEntries(response.headers) };
      try { await response.body?.cancel?.(); } catch { /* The response may already be closed. */ }
      return result;
    }
    case "tls": {
      const result = await connectTls(check.host, check.port, check.servername, timeoutMs);
      return { type: "tls", host: check.host, port: check.port, protocol: result.protocol, authorized: result.authorized };
    }
    default:
      throw new Error(`unsupported probe type: ${check.type}`);
  }
}

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", finish);
    socket.setTimeout(timeoutMs, () => finish(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

function connectTls(host, port, servername = host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port), servername, rejectUnauthorized: false });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      const details = error ? null : { protocol: socket.getProtocol(), authorized: socket.authorized };
      socket.destroy();
      if (error) reject(error);
      else resolve(details);
    };
    socket.once("secureConnect", () => finish());
    socket.once("error", finish);
    socket.setTimeout(timeoutMs, () => finish(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_TIMEOUT_MS);
}
