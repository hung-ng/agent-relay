import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

const timeoutPromise = (promise, timeoutMs) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const elapsed = (start) => Math.round((performance.now() - start) * 100) / 100;

export async function runProbe(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  if (checks.length === 0) throw new Error("network.probe requires at least one check");
  const results = [];
  for (const check of checks) {
    const started = performance.now();
    try {
      const result = await runCheck(check, payload.timeout_ms ?? 5000);
      results.push({ ...result, ok: true, duration_ms: elapsed(started) });
    } catch (error) {
      results.push({ type: check.type, ok: false, error: error.message, duration_ms: elapsed(started) });
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
  switch (check.type) {
    case "dns": {
      const addresses = await timeoutPromise(dns.lookup(check.name, { all: true }), timeoutMs);
      return { type: "dns", name: check.name, addresses };
    }
    case "tcp": {
      await timeoutPromise(connectTcp(check.host, check.port), timeoutMs);
      return { type: "tcp", host: check.host, port: check.port };
    }
    case "http": {
      const response = await timeoutPromise(fetch(check.url, { redirect: "manual" }), timeoutMs);
      return { type: "http", url: check.url, status: response.status, headers: Object.fromEntries(response.headers) };
    }
    case "tls": {
      const result = await timeoutPromise(connectTls(check.host, check.port, check.servername), timeoutMs);
      return { type: "tls", host: check.host, port: check.port, protocol: result.protocol, authorized: result.authorized };
    }
    default:
      throw new Error(`unsupported probe type: ${check.type}`);
  }
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", finish);
  });
}

function connectTls(host, port, servername = host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port), servername, rejectUnauthorized: false });
    const finish = (error) => {
      const details = error ? null : { protocol: socket.getProtocol(), authorized: socket.authorized };
      socket.destroy();
      if (error) reject(error);
      else resolve(details);
    };
    socket.once("secureConnect", () => finish());
    socket.once("error", finish);
  });
}
