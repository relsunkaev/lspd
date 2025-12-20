import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Writable } from "node:stream";

import { encodeMessage, readMessages, type JsonRpcMessage } from "../lsp/framing";
import { findBinaryForSpec, type ServerName } from "../discovery";
import { DiagnosticsBridge, type DiagnosticsBridgeConfig } from "./diagnosticsBridge";
import { resolveServer, type ServerSpec } from "../servers";

type JsonRpcId = string | number;

type MuxOptions = {
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  idleTimeoutMs?: number;
  silent?: boolean;
};

type InitState =
  | { state: "not_started" }
  | { state: "in_progress"; primaryClientId: number }
  | { state: "done"; response: { result?: unknown; error?: unknown } };

type PendingRequest = {
  clientId: number;
  originalId: JsonRpcId;
};

type PendingInternalRequest = {
  kind: "bridge_pull_diagnostics";
  uri: string;
};

type PendingServerRequest = {
  serverId: JsonRpcId;
};

type ClientConn = {
  id: number;
  socket: net.Socket;
  write: (msg: JsonRpcMessage) => void;
  close: () => void;
};

class BufferedWriter {
  private stream: Writable;
  private queue: Buffer[] = [];
  private waitingForDrain = false;
  private paused = false;
  private onBackpressure?: () => void;
  private onResume?: () => void;

  constructor(
    stream: Writable,
    hooks?: { onBackpressure?: () => void; onResume?: () => void },
  ) {
    this.stream = stream;
    this.onBackpressure = hooks?.onBackpressure;
    this.onResume = hooks?.onResume;
  }

  write(buf: Buffer): void {
    if (this.waitingForDrain) {
      this.queue.push(buf);
      this.pauseIfNeeded();
      return;
    }

    const ok = this.stream.write(buf);
    if (!ok) {
      this.waitingForDrain = true;
      this.pauseIfNeeded();
      this.stream.once("drain", () => this.flush());
      return;
    }
  }

  private flush(): void {
    this.waitingForDrain = false;

    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const ok = this.stream.write(next);
      if (!ok) {
        this.waitingForDrain = true;
        this.pauseIfNeeded();
        this.stream.once("drain", () => this.flush());
        return;
      }
    }

    if (!this.waitingForDrain && this.queue.length === 0 && this.paused) {
      this.paused = false;
      this.onResume?.();
    }
  }

  private pauseIfNeeded(): void {
    if (this.paused) return;
    this.paused = true;
    this.onBackpressure?.();
  }
}

export async function runDaemon(argv: string[]): Promise<void> {
  const { server, projectRoot, socketPath } = parseDaemonArgs(argv);

  await fs.mkdir(path.dirname(socketPath), { recursive: true });

  // If the socket path already exists but nothing is listening, remove it.
  if (await exists(socketPath)) {
    const alive = await canConnect(socketPath);
    if (!alive) await fs.rm(socketPath, { force: true });
  }

  const spec = resolveServer(server);
  if (!spec) {
    throw new Error(`Unknown server '${server}'`);
  }

  const lsp = await spawnLsp(spec, projectRoot);

  const state = new MuxState(spec, projectRoot, lsp);

  await state.startServerReadLoop();

  const serverSocket = net.createServer((sock) => state.addClient(sock));
  serverSocket.listen(socketPath);

  // Keep process alive.
  await new Promise<void>((_, reject) => {
    serverSocket.on("error", (err) => reject(err));
  });
}

function parseDaemonArgs(argv: string[]): {
  server: ServerName;
  projectRoot: string;
  socketPath: string;
} {
  let server: ServerName | undefined;
  let projectRoot: string | undefined;
  let socketPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server") {
      server = argv[++i];
      continue;
    }
    if (arg === "--projectRoot") {
      projectRoot = argv[++i];
      continue;
    }
    if (arg === "--socket") {
      socketPath = argv[++i];
      continue;
    }
  }

  if (!server || !projectRoot || !socketPath) {
    throw new Error("Missing required daemon args");
  }

  return { server, projectRoot, socketPath };
}

export class MuxState {
  private spec: ServerSpec;
  private projectRoot: string;
  private lsp: ChildProcessWithoutNullStreams;
  private lspWriter: BufferedWriter;
  private opts: MuxOptions;

  private nextClientId = 1;
  private clients = new Map<number, ClientConn>();
  private clientWriters = new Map<number, BufferedWriter>();
  private primaryClientId: number | null = null;

  private nextServerRequestId = 1;
  private pendingClientRequests = new Map<number, PendingRequest>();
  private pendingInternalRequests = new Map<number, PendingInternalRequest>();

  private clientSupportsPullDiagnostics = new Map<number, boolean>();
  private diagnosticsBridge: DiagnosticsBridge | null = null;
  private backpressuredClients = new Set<number>();

  // Maps negative client request ids (used for forwarding server-initiated requests)
  // to the original server request id.
  private nextForwardedServerReqId = -1;
  private pendingServerRequests = new Map<number, PendingServerRequest>();

  private init: InitState = { state: "not_started" };
  private queuedInitialize = new Array<{ clientId: number; id: JsonRpcId }>();
  private lspReadsPaused = false;
  private clientReadsPaused = false;

  private idleTimeoutMs: number;

  constructor(
    spec: ServerSpec,
    projectRoot: string,
    lsp: ChildProcessWithoutNullStreams,
    opts?: MuxOptions,
  ) {
    this.spec = spec;
    this.projectRoot = projectRoot;
    this.lsp = lsp;
    this.opts = opts ?? {};
    this.idleTimeoutMs = this.opts.idleTimeoutMs ?? 500;

    this.lspWriter = new BufferedWriter(lsp.stdin, {
      onBackpressure: () => this.pauseClientReads(),
      onResume: () => this.resumeClientReads(),
    });

    if (this.usesDiagnosticsBridge()) {
      this.diagnosticsBridge = new DiagnosticsBridge(
        this.spec.diagnostics as DiagnosticsBridgeConfig,
        {
          publish: (uri, diagnostics) => this.publishDiagnosticsToNonPullClients(uri, diagnostics),
          sendRequest: (uri, msg) => this.sendDiagnosticsRequest(uri, msg),
          hasNonPullClients: () => this.hasNonPullClients(),
        },
      );
    }
  }

  async startServerReadLoop(): Promise<void> {
    (async () => {
      try {
        for await (const msg of readMessages(this.lsp.stdout)) {
          this.onServerMessage(msg);
        }
      } catch (err) {
        if (!this.opts.silent) {
          process.stderr.write(`lspd: server read loop error: ${String(err)}\n`);
        }
      }
    })();

    this.lsp.on("exit", (code, signal) => {
      if (!this.opts.silent) {
        process.stderr.write(`lspd: LSP exited code=${code} signal=${signal}\n`);
      }
      for (const c of this.clients.values()) {
        c.close();
      }
      this.handleExit(code ?? 1, signal ?? null);
    });
  }

  addClient(socket: net.Socket): void {
    const clientId = this.nextClientId++;

    const writer = new BufferedWriter(socket, {
      onBackpressure: () => this.markClientBackpressure(clientId),
      onResume: () => this.clearClientBackpressure(clientId),
    });

    const conn: ClientConn = {
      id: clientId,
      socket,
      write: (msg) => {
        writer.write(encodeMessage(msg));
      },
      close: () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      },
    };

    this.clients.set(clientId, conn);
    this.clientWriters.set(clientId, writer);
    this.clientSupportsPullDiagnostics.set(clientId, false);

    if (this.primaryClientId == null) this.primaryClientId = clientId;

    socket.on("close", () => {
      this.clients.delete(clientId);
      this.clientWriters.delete(clientId);
      this.clientSupportsPullDiagnostics.delete(clientId);
      this.clearClientBackpressure(clientId);

      if (this.primaryClientId === clientId) {
        this.primaryClientId = this.clients.keys().next().value ?? null;
      }

      // If everyone disconnected, shut down the server after a short delay.
      if (this.clients.size === 0) {
        setTimeout(() => {
          if (this.clients.size === 0) this.shutdown();
        }, this.idleTimeoutMs);
      }
    });

    (async () => {
      try {
        for await (const msg of readMessages(socket)) {
          this.onClientMessage(clientId, msg);
        }
      } catch (err) {
        if (!this.opts.silent) {
          process.stderr.write(`lspd: client ${clientId} read error: ${String(err)}\n`);
        }
        conn.close();
      }
    })();
  }

  private markClientBackpressure(clientId: number): void {
    if (this.backpressuredClients.has(clientId)) return;
    this.backpressuredClients.add(clientId);
    this.pauseLspReads();
  }

  private clearClientBackpressure(clientId: number): void {
    if (!this.backpressuredClients.delete(clientId)) return;
    this.resumeLspReads();
  }

  private pauseLspReads(): void {
    if (this.lspReadsPaused) return;
    this.lspReadsPaused = true;
    this.lsp.stdout.pause();
  }

  private resumeLspReads(): void {
    if (!this.lspReadsPaused) return;
    if (this.backpressuredClients.size > 0) return;
    this.lspReadsPaused = false;
    this.lsp.stdout.resume();
  }

  private pauseClientReads(): void {
    if (this.clientReadsPaused) return;
    this.clientReadsPaused = true;
    for (const c of this.clients.values()) {
      c.socket.pause();
    }
  }

  private resumeClientReads(): void {
    if (!this.clientReadsPaused) return;
    this.clientReadsPaused = false;
    for (const c of this.clients.values()) {
      c.socket.resume();
    }
  }

  private shutdown(): void {
    try {
      this.lsp.kill();
    } catch {
      // ignore
    }
    this.handleExit(0, null);
  }

  private onClientMessage(clientId: number, msg: JsonRpcMessage): void {
    const method = msg.method;
    const id = msg.id as JsonRpcId | undefined;

    // Response (no method, has id)
    if (method == null && id != null) {
      this.onClientResponse(clientId, id, msg);
      return;
    }

    // Notification (has method, no id)
    if (method != null && id == null) {
      this.onClientNotification(clientId, String(method), msg);
      return;
    }

    // Request (has method + id)
    if (method != null && id != null) {
      this.onClientRequest(clientId, String(method), id, msg);
      return;
    }

    // Unknown message shape; just forward.
    this.writeToServer(msg);
  }

  private onClientNotification(clientId: number, method: string, msg: JsonRpcMessage): void {
    this.maybeTriggerDiagnosticsBridge(method, msg);

    if (method === "textDocument/didClose") {
      const uri = (msg as any).params?.textDocument?.uri;
      if (uri) this.diagnosticsBridge?.onDidClose(uri);
    }

    if (method === "initialized") {
      // Only forward the primary client's initialized.
      if (this.primaryClientId === clientId) {
        this.writeToServer(msg);
      }
      return;
    }

    this.writeToServer(msg);
  }

  private onClientRequest(
    clientId: number,
    method: string,
    id: JsonRpcId,
    msg: JsonRpcMessage,
  ): void {
    if (method === "initialize") {
      this.handleInitialize(clientId, id, msg);
      return;
    }

    // Normal client->server request. Translate id.
    const serverReqId = this.nextServerRequestId++;
    this.pendingClientRequests.set(serverReqId, { clientId, originalId: id });

    const forwarded = { ...msg, id: serverReqId };
    this.writeToServer(forwarded);
  }

  private handleInitialize(clientId: number, id: JsonRpcId, msg: JsonRpcMessage): void {
    this.recordClientCapabilities(clientId, msg);

    if (this.init.state === "done") {
      this.respondWithCachedInit(clientId, id, this.init.response);
      return;
    }

    if (this.init.state === "in_progress") {
      this.queuedInitialize.push({ clientId, id });
      return;
    }

    // First initialize becomes primary.
    this.init = { state: "in_progress", primaryClientId: clientId };
    if (this.primaryClientId == null) this.primaryClientId = clientId;

    const serverReqId = this.nextServerRequestId++;
    this.pendingClientRequests.set(serverReqId, { clientId, originalId: id });

    const initForServer = this.prepareInitializeForServer(msg);
    const forwarded = { ...initForServer, id: serverReqId };
    this.writeToServer(forwarded);
  }

  private onClientResponse(clientId: number, id: JsonRpcId, msg: JsonRpcMessage): void {
    // We only create numeric ids for forwarded server requests.
    if (typeof id !== "number") {
      this.writeToServer(msg);
      return;
    }

    const pending = this.pendingServerRequests.get(id);
    if (!pending) {
      this.writeToServer(msg);
      return;
    }

    this.pendingServerRequests.delete(id);

    const forwarded = { ...msg, id: pending.serverId };
    this.writeToServer(forwarded);
  }

  private onServerMessage(msg: JsonRpcMessage): void {
    const method = msg.method;
    const id = msg.id as JsonRpcId | undefined;

    // Server response
    if (method == null && id != null) {
      this.onServerResponse(id, msg);
      return;
    }

    // Server notification
    if (method != null && id == null) {
      this.broadcast(msg);
      return;
    }

    // Server request
    if (method != null && id != null) {
      this.onServerRequest(String(method), id, msg);
      return;
    }

    this.broadcast(msg);
  }

  private onServerResponse(id: JsonRpcId, msg: JsonRpcMessage): void {
    if (typeof id !== "number") {
      // If a server uses non-numeric ids, we can't route reliably.
      // Broadcast as best effort.
      this.broadcast(msg);
      return;
    }

    const internal = this.pendingInternalRequests.get(id);
    if (internal) {
      this.pendingInternalRequests.delete(id);
      this.onInternalServerResponse(internal, msg);
      return;
    }

    const pending = this.pendingClientRequests.get(id);
    if (!pending) {
      this.broadcast(msg);
      return;
    }

    this.pendingClientRequests.delete(id);

    // Initialize response caching.
    if (this.init.state === "in_progress" && pending.clientId === this.init.primaryClientId) {
      const response = { result: (msg as any).result, error: (msg as any).error };
      this.init = { state: "done", response };
      this.flushQueuedInitialize();
      this.diagnosticsBridge?.markInitDone();
    }

    const client = this.clients.get(pending.clientId);
    if (!client) return;

    const forwarded = { ...msg, id: pending.originalId };
    client.write(forwarded);
  }

  private flushQueuedInitialize(): void {
    if (this.init.state !== "done") return;

    const cached = this.init.response;
    const queued = this.queuedInitialize;
    this.queuedInitialize = [];

    for (const entry of queued) {
      this.respondWithCachedInit(entry.clientId, entry.id, cached);
    }
  }

  private onServerRequest(method: string, id: JsonRpcId, msg: JsonRpcMessage): void {
    // Some servers require these for initialization; many clients don't implement them.
    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      this.writeToServer({ jsonrpc: "2.0", id, result: null });
      return;
    }

    if (method === "workspace/configuration") {
      const items = (msg as any).params?.items as unknown[] | undefined;
      // Returning `null` is closer to how many editors behave when they have
      // no explicit settings to provide. Some servers use this as a signal to
      // fall back to auto-discovery of on-disk config.
      const result = Array.isArray(items) ? items.map(() => null) : [];
      this.writeToServer({ jsonrpc: "2.0", id, result });
      return;
    }

    const target = this.primaryClientId != null ? this.clients.get(this.primaryClientId) : null;

    // If no clients, respond with "Method not found".
    if (!target) {
      this.writeToServer({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "No clients connected" },
      });
      return;
    }

    // Forward to primary client with a negative id to avoid collisions.
    const forwardedId = this.nextForwardedServerReqId--;
    this.pendingServerRequests.set(forwardedId, { serverId: id });

    const forwarded = { ...msg, id: forwardedId };
    target.write(forwarded);
  }

  private prepareInitializeForServer(msg: JsonRpcMessage): JsonRpcMessage {
    const hook = this.spec.hooks?.prepareInitialize;
    return hook ? hook(msg) : msg;
  }

  private recordClientCapabilities(clientId: number, msg: JsonRpcMessage): void {
    const caps = (msg as any).params?.capabilities;
    const hasPullDiagnostics = Boolean(caps?.textDocument?.diagnostic);
    this.clientSupportsPullDiagnostics.set(clientId, hasPullDiagnostics);
  }

  private maybeTriggerDiagnosticsBridge(method: string, msg: JsonRpcMessage): void {
    if (!this.usesDiagnosticsBridge()) return;

    let uri: string | undefined;

    if (method === "textDocument/didOpen") {
      uri = (msg as any).params?.textDocument?.uri;
    } else if (method === "textDocument/didChange") {
      uri = (msg as any).params?.textDocument?.uri;
    } else if (method === "textDocument/didSave") {
      uri = (msg as any).params?.textDocument?.uri;
    }

    if (!uri) return;
    this.diagnosticsBridge?.onFileEvent(method, uri);
  }

  private onInternalServerResponse(internal: PendingInternalRequest, msg: JsonRpcMessage): void {
    if (internal.kind === "bridge_pull_diagnostics") {
      this.diagnosticsBridge?.onServerResponse(internal.uri, msg);
      return;
    }
  }

  private publishDiagnosticsToNonPullClients(uri: string, diagnostics: unknown[]): void {
    for (const [clientId, c] of this.clients) {
      if (this.clientSupportsPullDiagnostics.get(clientId)) continue;

      c.write({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics },
      } as JsonRpcMessage);
    }
  }

  private respond(clientId: number, id: JsonRpcId, result: unknown): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.write({ jsonrpc: "2.0", id, result } as JsonRpcMessage);
  }

  private respondWithCachedInit(
    clientId: number,
    id: JsonRpcId,
    cached: { result?: unknown; error?: unknown },
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (cached.error != null) {
      client.write({ jsonrpc: "2.0", id, error: cached.error } as JsonRpcMessage);
      return;
    }

    client.write({ jsonrpc: "2.0", id, result: cached.result } as JsonRpcMessage);
  }

  private broadcast(msg: JsonRpcMessage): void {
    for (const c of this.clients.values()) {
      c.write(msg);
    }
  }

  private writeToServer(msg: JsonRpcMessage): void {
    this.lspWriter.write(encodeMessage(msg));
  }

  private sendDiagnosticsRequest(uri: string, msg: JsonRpcMessage): void {
    const serverReqId = this.nextServerRequestId++;
    this.pendingInternalRequests.set(serverReqId, { kind: "bridge_pull_diagnostics", uri });
    this.writeToServer({ ...msg, id: serverReqId });
  }

  private hasNonPullClients(): boolean {
    for (const clientId of this.clients.keys()) {
      if (!this.clientSupportsPullDiagnostics.get(clientId)) return true;
    }
    return false;
  }

  private usesDiagnosticsBridge(): boolean {
    return this.spec.diagnostics?.mode === "pullToPushBridge";
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.opts.onExit) {
      this.opts.onExit(code, signal);
      return;
    }

    process.exitCode = code ?? 1;
    process.exit();
  }
}

async function spawnLsp(
  spec: ServerSpec,
  projectRoot: string,
): Promise<ChildProcessWithoutNullStreams> {
  const { cmd, args } = await findBinaryForSpec(spec, projectRoot);

  // If we found a JS entrypoint (e.g. @typescript/native-preview/bin/tsgo.js),
  // run it with Node to match upstream expectations.
  if (cmd.endsWith(".js") || cmd.endsWith(".mjs")) {
    const child = childProcess.spawn("node", [cmd, ...args], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return child;
  }

  const child = childProcess.spawn(cmd, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return child;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canConnect(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    });
  }
