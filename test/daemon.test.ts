import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";

import { MuxState } from "../src/daemon/daemon";
import { encodeMessage, readMessages, type JsonRpcMessage } from "../src/lsp/framing";
import { resolveServer } from "../src/servers";

const repoRoot = path.resolve(import.meta.dir, "..");

let tmpDir: string;

beforeEach(async () => {
  const tmpRoot = path.join(repoRoot, "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(tmpRoot, "mux-"));
});

afterEach(async () => {
  if (process.env.KEEP_LSPD_TEST_ARTIFACTS === "1") return;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mux core behavior", () => {
  test("tsgo injects pull-diagnostic capability and caches init response", async () => {
    const projectRoot = await fs.mkdtemp(path.join(tmpDir, "proj-"));
    const lsp = createFakeLsp({ includeInitCapabilities: true });
    const tsgo = resolveServer("tsgo")!;
    const mux = new MuxState(tsgo, projectRoot, lsp.proc as any, { onExit: () => {}, silent: true });
    await mux.startServerReadLoop();

    const c1 = socketPair();
    mux.addClient(c1.server);
    const iter1 = readMessages(c1.client)[Symbol.asyncIterator]();

    writeToClient(c1.client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: `file://${projectRoot}`, capabilities: {} },
    });

    const init1 = await waitFor(iter1, (m) => m.id === 1, 5_000);
    const caps1 = (init1 as any).result?.receivedCapabilities;
    expect((init1 as any).result?.initCount).toBe(1);
    expect(caps1?.textDocument?.diagnostic).toBeTruthy();

    const c2 = socketPair();
    mux.addClient(c2.server);
    const iter2 = readMessages(c2.client)[Symbol.asyncIterator]();

    writeToClient(c2.client, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { processId: null, rootUri: `file://${projectRoot}`, capabilities: {} },
    });

    const init2 = await waitFor(iter2, (m) => m.id === 2, 5_000);
    expect((init2 as any).result?.initCount).toBe(1);

    c1.client.end();
    c1.server.end();
    c2.client.end();
    c2.server.end();
    lsp.proc.kill();
  });

  test("tsgo bridges pull diagnostics to non-pull clients only", async () => {
    const projectRoot = await fs.mkdtemp(path.join(tmpDir, "proj-"));
    const lsp = createFakeLsp({ diagnosticItems: [{ message: "from pull" }] });
    const tsgo = resolveServer("tsgo")!;
    const mux = new MuxState(tsgo, projectRoot, lsp.proc as any, { onExit: () => {}, silent: true });
    await mux.startServerReadLoop();

    const nonPull = socketPair();
    mux.addClient(nonPull.server);
    const iterNonPull = readMessages(nonPull.client)[Symbol.asyncIterator]();

    writeToClient(nonPull.client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: `file://${projectRoot}`, capabilities: {} },
    });
    await waitFor(iterNonPull, (m) => m.id === 1, 5_000);

    const pull = socketPair();
    mux.addClient(pull.server);
    const iterPull = readMessages(pull.client)[Symbol.asyncIterator]();

    writeToClient(pull.client, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        processId: null,
        rootUri: `file://${projectRoot}`,
        capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } },
      },
    });
    await waitFor(iterPull, (m) => m.id === 2, 5_000);

    const fileUri = `file://${path.join(projectRoot, "file.ts")}`;
    writeToClient(nonPull.client, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: fileUri,
          languageId: "typescript",
          version: 1,
          text: "const n: number = 'nope';\n",
        },
      },
    });
    writeToClient(nonPull.client, {
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: { textDocument: { uri: fileUri } },
    });

    const diag = await waitFor(
      iterNonPull,
      (m) => m.method === "textDocument/publishDiagnostics",
      5_000,
    );
    expect((diag as any).params?.diagnostics?.[0]?.message).toBe("from pull");

    let gotDiagOnPullClient = false;
    try {
      await waitFor(
        iterPull,
        (m) => m.method === "textDocument/publishDiagnostics",
        1_000,
      );
      gotDiagOnPullClient = true;
    } catch {
      // expected
    }
    expect(gotDiagOnPullClient).toBe(false);

    nonPull.client.end();
    nonPull.server.end();
    pull.client.end();
    pull.server.end();
    lsp.proc.kill();
  });

  test("routes server->client requests and forwards responses", async () => {
    const projectRoot = await fs.mkdtemp(path.join(tmpDir, "proj-"));
    const tsgo = resolveServer("tsgo")!;
    let serverResponse: JsonRpcMessage | null = null;

    const lsp = createFakeLsp({
      serverRequest: {
        method: "custom/ping",
        params: { value: 123 },
        onResponse: (msg) => {
          serverResponse = msg;
        },
      },
    });

    const mux = new MuxState(tsgo, projectRoot, lsp.proc as any, { onExit: () => {}, silent: true });
    await mux.startServerReadLoop();

    const c = socketPair();
    mux.addClient(c.server);
    const iter = readMessages(c.client)[Symbol.asyncIterator]();

    writeToClient(c.client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: `file://${projectRoot}`, capabilities: {} },
    });
    await waitFor(iter, (m) => m.id === 1, 5_000);

    const serverReq = await waitFor(
      iter,
      (m) => m.method === "custom/ping" && typeof (m as any).id === "number",
      5_000,
    );

    writeToClient(c.client, {
      jsonrpc: "2.0",
      id: (serverReq as any).id,
      result: { pong: true },
    });

    const resp = await waitForPromise(
      () => serverResponse,
      2_000,
      "waiting for server-side response",
    );
    expect(resp?.id).toBe(1);
    expect((resp as any).result).toEqual({ pong: true });

    c.client.end();
    c.server.end();
    lsp.proc.kill();
  });
});

type FakeLspBehavior = {
  diagnosticItems?: unknown[];
  includeInitCapabilities?: boolean;
  initResult?: Record<string, unknown>;
  serverRequest?: {
    method?: string;
    params?: unknown;
    onResponse?: (msg: JsonRpcMessage) => void;
  };
};

function createFakeLsp(behavior: FakeLspBehavior = {}): {
  proc: FakeChildProcess;
} {
  const proc = new FakeChildProcess();
  let nextRequestId = 1;
  const pending = new Map<number, { onResponse?: (msg: JsonRpcMessage) => void }>();

  (async () => {
    let initCount = 0;

    for await (const msg of readMessages(proc.stdin)) {
      const method = msg.method as string | undefined;
      const id = msg.id as number | undefined;

      if (method === "initialize") {
        initCount++;
        const caps = (msg as any).params?.capabilities ?? {};
        const result = { capabilities: {}, initCount, ...(behavior.initResult ?? {}) };
        if (behavior.includeInitCapabilities) {
          (result as any).receivedCapabilities = caps;
        }

        proc.stdout.write(encodeMessage({ jsonrpc: "2.0", id, result }));

        if (behavior.serverRequest) {
          const reqId = nextRequestId++;
          pending.set(reqId, { onResponse: behavior.serverRequest.onResponse });
          proc.stdout.write(
            encodeMessage({
              jsonrpc: "2.0",
              id: reqId,
              method: behavior.serverRequest.method ?? "custom/ping",
              params: behavior.serverRequest.params ?? {},
            }),
          );
        }
        continue;
      }

      if (method === "textDocument/diagnostic") {
        const items = Array.isArray(behavior.diagnosticItems)
          ? behavior.diagnosticItems
          : [{ message: "fake diagnostic" }];
        proc.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id,
            result: { kind: "full", items },
          }),
        );
        continue;
      }

      if (id != null && pending.has(id)) {
        const handler = pending.get(id);
        pending.delete(id);
        handler?.onResponse?.(msg);
      }
    }
  })();

  return { proc };
}

class FakeChildProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  kill(): void {
    this.stdout.end();
    this.stdin.end();
    for (const h of this.exitHandlers) {
      h(0, null);
    }
  }

  on(event: string, handler: (...args: any[]) => void): this {
    if (event === "exit") {
      this.exitHandlers.push(handler as any);
    }
    return this;
  }
}

function socketPair(): { client: InMemorySocket; server: InMemorySocket } {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const client = new InMemorySocket(bToA, aToB);
  const server = new InMemorySocket(aToB, bToA);
  return { client, server };
}

class InMemorySocket extends Duplex {
  private incoming: PassThrough;
  private outgoing: PassThrough;

  constructor(incoming: PassThrough, outgoing: PassThrough) {
    super();
    this.incoming = incoming;
    this.outgoing = outgoing;

    this.incoming.on("data", (chunk) => {
      this.push(chunk);
    });
    this.incoming.on("end", () => {
      this.push(null);
    });
  }

  _read(): void {
    // Driven by incoming stream events.
  }

  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outgoing.write(chunk);
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    this.outgoing.end();
    callback();
  }

  override destroy(error?: Error | null): this {
    this.incoming.destroy();
    this.outgoing.destroy();
    return super.destroy(error);
  }
}

function writeToClient(sock: Duplex, msg: JsonRpcMessage): void {
  sock.write(encodeMessage(msg));
}

async function waitFor(
  iter: AsyncIterator<JsonRpcMessage>,
  predicate: (msg: JsonRpcMessage) => boolean,
  timeoutMs: number,
): Promise<JsonRpcMessage> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const next = await Promise.race([
      iter.next(),
      sleep(Math.min(250, Math.max(0, deadline - Date.now()))).then(
        () => ({ timeout: true }) as const,
      ),
    ]);

    if ((next as any).timeout) continue;

    const r = next as IteratorResult<JsonRpcMessage>;
    if (r.done) break;

    if (predicate(r.value)) return r.value;
  }

  throw new Error("Timed out waiting for matching LSP message");
}

async function waitForPromise<T>(
  getter: () => T | null | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = getter();
    if (val != null) return val;
    await sleep(50);
  }
  throw new Error(`Timed out ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
