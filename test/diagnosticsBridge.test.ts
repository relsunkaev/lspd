import { describe, expect, test } from "bun:test";

import { DiagnosticsBridge } from "../src/daemon/diagnosticsBridge";
import type { JsonRpcMessage } from "../src/lsp/framing";

describe("DiagnosticsBridge", () => {
  test("debounces and sends a single pull request", async () => {
    const sent: Array<{ uri: string; msg: JsonRpcMessage }> = [];
    const bridge = new DiagnosticsBridge(
      { debounceMs: 5 },
      {
        sendRequest: (uri, msg) => sent.push({ uri, msg }),
        publish: () => {},
        hasNonPullClients: () => true,
      },
    );

    bridge.markInitDone();
    bridge.onFileEvent("textDocument/didOpen", "file:///a.ts");
    bridge.onFileEvent("textDocument/didSave", "file:///a.ts");

    await sleep(15);
    expect(sent.length).toBe(1);
    expect(sent[0]?.msg.method).toBe("textDocument/diagnostic");
  });

  test("queues before init and replays after init", async () => {
    const sent: string[] = [];
    const bridge = new DiagnosticsBridge(
      { debounceMs: 1 },
      {
        sendRequest: (uri) => sent.push(uri),
        publish: () => {},
        hasNonPullClients: () => true,
      },
    );

    bridge.onFileEvent("textDocument/didOpen", "file:///queued.ts");
    await sleep(5);
    expect(sent.length).toBe(0);

    bridge.markInitDone();
    await sleep(5);
    expect(sent).toEqual(["file:///queued.ts"]);
  });

  test("reuses cached diagnostics on unchanged responses", () => {
    const published: Array<{ uri: string; diags: unknown[] }> = [];
    const bridge = new DiagnosticsBridge(
      {},
      {
        sendRequest: () => {},
        publish: (uri, diags) => published.push({ uri, diags }),
        hasNonPullClients: () => true,
      },
    );

    bridge.markInitDone();
    bridge.onServerResponse("file:///a.ts", {
      jsonrpc: "2.0",
      id: 1,
      result: { kind: "full", items: [{ message: "first" }] },
    });

    bridge.onServerResponse("file:///a.ts", {
      jsonrpc: "2.0",
      id: 2,
      result: { kind: "unchanged" },
    });

    expect(published.map((p) => p.diags)).toEqual([
      [{ message: "first" }],
      [{ message: "first" }],
    ]);
  });

  test("no-ops when no non-pull clients", async () => {
    const sent: Array<{ uri: string; msg: JsonRpcMessage }> = [];
    const bridge = new DiagnosticsBridge(
      { debounceMs: 1 },
      {
        sendRequest: (uri, msg) => sent.push({ uri, msg }),
        publish: () => {
          throw new Error("should not publish");
        },
        hasNonPullClients: () => false,
      },
    );

    bridge.markInitDone();
    bridge.onFileEvent("textDocument/didOpen", "file:///skip.ts");
    await sleep(5);
    expect(sent.length).toBe(0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
