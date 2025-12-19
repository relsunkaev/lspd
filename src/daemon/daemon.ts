import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { encodeMessage, readMessages, type JsonRpcMessage } from "../lsp/framing";
import { findBinary, type ServerName } from "../discovery";

type JsonRpcId = string | number;

type InitState =
  | { state: "not_started" }
  | { state: "in_progress"; primaryClientId: number }
  | { state: "done"; response: { result?: unknown; error?: unknown } };

type PendingRequest = {
  clientId: number;
  originalId: JsonRpcId;
};

type PendingInternalRequest = {
  kind: "tsgo_pull_diagnostics";
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

export async function runDaemon(argv: string[]): Promise<void> {
  const { server, projectRoot, socketPath } = parseDaemonArgs(argv);

  await fs.mkdir(path.dirname(socketPath), { recursive: true });

  // If the socket path already exists but nothing is listening, remove it.
  if (await exists(socketPath)) {
    const alive = await canConnect(socketPath);
    if (!alive) await fs.rm(socketPath, { force: true });
  }

  const lsp = await spawnLsp(server, projectRoot);

  const state = new MuxState(server, projectRoot, lsp);

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
      const v = argv[++i];
      if (v === "tsgo" || v === "oxlint") server = v;
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

class MuxState {
  private server: ServerName;
  private projectRoot: string;
  private lsp: ChildProcessWithoutNullStreams;

  private nextClientId = 1;
  private clients = new Map<number, ClientConn>();
  private primaryClientId: number | null = null;

  private nextServerRequestId = 1;
  private pendingClientRequests = new Map<number, PendingRequest>();
  private pendingInternalRequests = new Map<number, PendingInternalRequest>();

  private clientSupportsPullDiagnostics = new Map<number, boolean>();
  private diagnosticDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private diagnosticsInFlight = new Set<string>();
  private lastPublishedDiagnostics = new Map<string, unknown[]>();
  private pendingDiagnosticsAfterInit = new Set<string>();

  // Maps negative client request ids (used for forwarding server-initiated requests)
  // to the original server request id.
  private nextForwardedServerReqId = -1;
  private pendingServerRequests = new Map<number, PendingServerRequest>();

  private init: InitState = { state: "not_started" };
  private queuedInitialize = new Array<{ clientId: number; id: JsonRpcId }>();

  constructor(server: ServerName, projectRoot: string, lsp: ChildProcessWithoutNullStreams) {
    this.server = server;
    this.projectRoot = projectRoot;
    this.lsp = lsp;
  }

  async startServerReadLoop(): Promise<void> {
    (async () => {
      try {
        for await (const msg of readMessages(this.lsp.stdout)) {
          this.onServerMessage(msg);
        }
      } catch (err) {
        process.stderr.write(`lspd: server read loop error: ${String(err)}\n`);
      }
    })();

    this.lsp.on("exit", (code, signal) => {
      process.stderr.write(`lspd: LSP exited code=${code} signal=${signal}\n`);
      for (const c of this.clients.values()) {
        c.close();
      }
      process.exitCode = code ?? 1;
      process.exit();
    });
  }

  addClient(socket: net.Socket): void {
    const clientId = this.nextClientId++;

    const conn: ClientConn = {
      id: clientId,
      socket,
      write: (msg) => {
        socket.write(encodeMessage(msg));
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
    this.clientSupportsPullDiagnostics.set(clientId, false);

    if (this.primaryClientId == null) this.primaryClientId = clientId;

    socket.on("close", () => {
      this.clients.delete(clientId);
      this.clientSupportsPullDiagnostics.delete(clientId);

      if (this.primaryClientId === clientId) {
        this.primaryClientId = this.clients.keys().next().value ?? null;
      }

      // If everyone disconnected, shut down the server after a short delay.
      if (this.clients.size === 0) {
        setTimeout(() => {
          if (this.clients.size === 0) this.shutdown();
        }, 500);
      }
    });

    (async () => {
      try {
        for await (const msg of readMessages(socket)) {
          this.onClientMessage(clientId, msg);
        }
      } catch (err) {
        process.stderr.write(`lspd: client ${clientId} read error: ${String(err)}\n`);
        conn.close();
      }
    })();
  }

  private shutdown(): void {
    try {
      this.lsp.kill();
    } catch {
      // ignore
    }
    process.exit(0);
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
    this.maybeTriggerTsgoDiagnostics(method, msg);

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
      this.flushQueuedDiagnosticsAfterInit();
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
    if (this.server !== "tsgo") return msg;

    // Always advertise pull diagnostics support to tsgo.
    // This lets the mux request diagnostics even if some clients can't.
    const params = (msg as any).params ?? {};
    const caps = params.capabilities ?? {};
    const textDocument = caps.textDocument ?? {};

    if (textDocument.diagnostic) return msg;

    return {
      ...msg,
      params: {
        ...params,
        capabilities: {
          ...caps,
          textDocument: {
            ...textDocument,
            diagnostic: { dynamicRegistration: false },
          },
        },
      },
    } as JsonRpcMessage;
  }

  private recordClientCapabilities(clientId: number, msg: JsonRpcMessage): void {
    const caps = (msg as any).params?.capabilities;
    const hasPullDiagnostics = Boolean(caps?.textDocument?.diagnostic);
    this.clientSupportsPullDiagnostics.set(clientId, hasPullDiagnostics);
  }

  private maybeTriggerTsgoDiagnostics(method: string, msg: JsonRpcMessage): void {
    if (this.server !== "tsgo") return;

    // Only useful if at least one connected client can't do pull diagnostics.
    let needsBridge = false;
    for (const clientId of this.clients.keys()) {
      if (!this.clientSupportsPullDiagnostics.get(clientId)) {
        needsBridge = true;
        break;
      }
    }
    if (!needsBridge) return;

    let uri: string | undefined;

    if (method === "textDocument/didOpen") {
      uri = (msg as any).params?.textDocument?.uri;
    } else if (method === "textDocument/didChange") {
      uri = (msg as any).params?.textDocument?.uri;
    } else if (method === "textDocument/didSave") {
      uri = (msg as any).params?.textDocument?.uri;
    }

    if (!uri) return;
    this.scheduleTsgoDiagnostics(uri);
  }

  private scheduleTsgoDiagnostics(uri: string): void {
    if (this.server !== "tsgo") return;

    if (this.init.state !== "done") {
      this.pendingDiagnosticsAfterInit.add(uri);
      return;
    }

    const existing = this.diagnosticDebounce.get(uri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.diagnosticDebounce.delete(uri);
      this.requestTsgoDiagnostics(uri);
    }, 150);

    this.diagnosticDebounce.set(uri, timer);
  }

  private requestTsgoDiagnostics(uri: string): void {
    if (this.server !== "tsgo") return;
    if (this.diagnosticsInFlight.has(uri)) return;

    this.diagnosticsInFlight.add(uri);

    const serverReqId = this.nextServerRequestId++;
    this.pendingInternalRequests.set(serverReqId, { kind: "tsgo_pull_diagnostics", uri });

    this.writeToServer({
      jsonrpc: "2.0",
      id: serverReqId,
      method: "textDocument/diagnostic",
      params: {
        textDocument: { uri },
        identifier: null,
        previousResultId: null,
      },
    } as JsonRpcMessage);
  }

  private onInternalServerResponse(internal: PendingInternalRequest, msg: JsonRpcMessage): void {
    if (internal.kind === "tsgo_pull_diagnostics") {
      this.diagnosticsInFlight.delete(internal.uri);

      const result = (msg as any).result;

      let diagnostics: unknown[] = [];
      if (result?.kind === "full" && Array.isArray(result.items)) {
        diagnostics = result.items;
      } else if (result?.kind === "unchanged") {
        diagnostics = this.lastPublishedDiagnostics.get(internal.uri) ?? [];
      } else if (Array.isArray(result?.items)) {
        diagnostics = result.items;
      }

      this.lastPublishedDiagnostics.set(internal.uri, diagnostics);
      this.publishDiagnosticsToNonPullClients(internal.uri, diagnostics);
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

  private flushQueuedDiagnosticsAfterInit(): void {
    if (this.server !== "tsgo") return;
    if (this.init.state !== "done") return;

    const queued = Array.from(this.pendingDiagnosticsAfterInit);
    this.pendingDiagnosticsAfterInit.clear();

    for (const uri of queued) {
      this.scheduleTsgoDiagnostics(uri);
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
    this.lsp.stdin.write(encodeMessage(msg));
  }
}

async function spawnLsp(
  server: ServerName,
  projectRoot: string,
): Promise<ChildProcessWithoutNullStreams> {
  const { cmd, args } = await findBinary(server, projectRoot);

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
