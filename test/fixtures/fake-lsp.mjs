#!/usr/bin/env node
import fs from "node:fs";
import { Readable } from "node:stream";

/**
 * Lightweight fake LSP server for tests. Behavior is configured via the
 * FAKE_LSP_BEHAVIOR env var (JSON string).
 *
 * Supported options:
 *  - diagnosticItems: array of diagnostics returned from textDocument/diagnostic.
 *  - includeInitCapabilities: include the received initialize capabilities in the result.
 *  - initResult: object merged into initialize result.
 *  - serverRequest: { method, params, recordResponseTo } to issue a server->client request
 *    after initialize and record the response to a file.
 */
const behavior = parseBehavior();
const logFile = process.env.FAKE_LSP_LOG;

let initCount = 0;
let nextRequestId = 1;
const pendingServerRequests = new Map();

log({ event: "start", argv: process.argv.slice(2), behavior });

(async () => {
  try {
    for await (const msg of readMessages(process.stdin)) {
      const method = msg.method;
      const id = msg.id;

      if (method === "initialize") {
        initCount++;
        log({ event: "initialize", params: msg.params, id });
        handleInitialize(msg);
        continue;
      }

      if (method === "textDocument/diagnostic") {
        log({ event: "diagnosticRequest", id });
        handleDiagnosticRequest(id);
        continue;
      }

      if (id != null && pendingServerRequests.has(id)) {
        const pending = pendingServerRequests.get(id);
        pendingServerRequests.delete(id);
        if (pending.recordResponseTo) {
          try {
            fs.writeFileSync(pending.recordResponseTo, JSON.stringify(msg));
          } catch {
            // ignore
          }
        }
        log({ event: "responseToServerRequest", id, msg });
        continue;
      }
    }
  } catch (err) {
    log({ event: "error", message: String(err), stack: err?.stack });
    process.exit(1);
  }
})();

process.on("uncaughtException", (err) => {
  log({ event: "uncaughtException", message: String(err), stack: err?.stack });
});

process.on("unhandledRejection", (err) => {
  log({ event: "unhandledRejection", message: String(err), stack: err?.stack });
});

function handleInitialize(msg) {
  const id = msg.id;
  const params = msg.params ?? {};
  const caps = params.capabilities ?? {};

  const result = {
    capabilities: {},
    initCount,
    ...clone(behavior.initResult ?? {}),
  };

  if (behavior.includeInitCapabilities) {
    result.receivedCapabilities = caps;
  }

  write({ jsonrpc: "2.0", id, result });

  if (behavior.serverRequest) {
    const reqId = behavior.serverRequest.id ?? nextRequestId++;
    pendingServerRequests.set(reqId, behavior.serverRequest);
    write({
      jsonrpc: "2.0",
      id: reqId,
      method: behavior.serverRequest.method ?? "custom/ping",
      params: behavior.serverRequest.params ?? {},
    });
  }
}

function handleDiagnosticRequest(id) {
  const items = Array.isArray(behavior.diagnosticItems)
    ? behavior.diagnosticItems
    : [{ message: "fake diagnostic" }];

  write({
    jsonrpc: "2.0",
    id,
    result: {
      kind: "full",
      items,
    },
  });
}

function write(msg) {
  process.stdout.write(encodeMessage(msg));
}

function parseBehavior() {
  const raw = process.env.FAKE_LSP_BEHAVIOR;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function log(entry) {
  if (!logFile) return;
  try {
    const payload = { ts: Date.now(), ...entry };
    fs.appendFileSync(logFile, JSON.stringify(payload) + "\n");
  } catch {
    // ignore
  }
}

function encodeMessage(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

async function* readMessages(readable) {
  let buffer = Buffer.allocUnsafe(8192);
  let start = 0;
  let end = 0;

  const ensureCapacity = (incoming) => {
    const available = buffer.length - end;
    if (available >= incoming) return;

    if (start > 0) {
      buffer.copy(buffer, 0, start, end);
      end -= start;
      start = 0;
    }

    if (buffer.length - end >= incoming) return;

    const used = end - start;
    const nextSize = Math.max(buffer.length * 2, used + incoming);
    const next = Buffer.allocUnsafe(nextSize);
    buffer.copy(next, 0, start, end);
    buffer = next;
    end = used;
    start = 0;
  };

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    ensureCapacity(buf.length);
    buf.copy(buffer, end);
    end += buf.length;

    while (true) {
      const headerIdx = buffer.subarray(start, end).indexOf("\r\n\r\n");
      if (headerIdx === -1) break;

      const headerEnd = start + headerIdx;
      const header = buffer.toString("utf8", start, headerEnd);
      const contentLength = parseContentLength(header);
      if (contentLength == null) {
        throw new Error(`Missing Content-Length header: ${header}`);
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (end < messageEnd) break;

      const body = buffer.toString("utf8", messageStart, messageEnd);
      start = messageEnd;
      if (start === end) {
        start = 0;
        end = 0;
      }

      yield JSON.parse(body);
    }
  }
}

function parseContentLength(header) {
  for (const line of header.split("\r\n")) {
    const [k, v] = line.split(":");
    if (!k || !v) continue;
    if (k.toLowerCase() === "content-length") {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}
