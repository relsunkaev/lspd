import { Readable } from "node:stream";

export type JsonRpcMessage = Record<string, unknown>;

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

export async function* readMessages(readable: Readable): AsyncGenerator<JsonRpcMessage> {
  let buffer = Buffer.allocUnsafe(8192);
  let start = 0;
  let end = 0;

  const ensureCapacity = (incoming: number) => {
    const available = buffer.length - end;
    if (available >= incoming) return;

    // Slide existing data to the start if there's slack.
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

      yield JSON.parse(body) as JsonRpcMessage;
    }
  }
}

function parseContentLength(header: string): number | null {
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
