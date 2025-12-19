import { Readable } from "node:stream";

export type JsonRpcMessage = Record<string, unknown>;

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

export async function* readMessages(readable: Readable): AsyncGenerator<JsonRpcMessage> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of readable) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(header);
      if (contentLength == null) {
        throw new Error(`Missing Content-Length header: ${header}`);
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) break;

      const body = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);

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
