import type { JsonRpcMessage } from "../lsp/framing";

export type DiagnosticsBridgeConfig = {
  debounceMs?: number;
  buildRequest?: (uri: string) => JsonRpcMessage;
};

type SendRequest = (uri: string, msg: JsonRpcMessage) => void;
type PublishDiagnostics = (uri: string, diagnostics: unknown[]) => void;
type HasNonPullClients = () => boolean;

/**
 * DiagnosticsBridge converts pull-diagnostics responses into publishDiagnostics
 * notifications for clients that don't support pull diagnostics. It tracks
 * capabilities per client and caches the last diagnostics per URI to support
 * "unchanged" responses.
 */
export class DiagnosticsBridge {
  private cfg: DiagnosticsBridgeConfig;
  private sendRequest: SendRequest;
  private publish: PublishDiagnostics;
  private hasNonPullClients: HasNonPullClients;

  private diagnosticDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private diagnosticsInFlight = new Set<string>();
  private lastPublishedDiagnostics = new Map<string, unknown[]>();
  private pendingDiagnosticsAfterInit = new Set<string>();
  private initDone = false;

  constructor(
    cfg: DiagnosticsBridgeConfig,
    deps: {
      sendRequest: SendRequest;
      publish: PublishDiagnostics;
      hasNonPullClients: HasNonPullClients;
    },
  ) {
    this.cfg = cfg;
    this.sendRequest = deps.sendRequest;
    this.publish = deps.publish;
    this.hasNonPullClients = deps.hasNonPullClients;
  }

  markInitDone(): void {
    this.initDone = true;
    const queued = Array.from(this.pendingDiagnosticsAfterInit);
    this.pendingDiagnosticsAfterInit.clear();
    for (const uri of queued) {
      this.schedule(uri);
    }
  }

  onDidClose(uri: string): void {
    const timer = this.diagnosticDebounce.get(uri);
    if (timer) clearTimeout(timer);
    this.diagnosticDebounce.delete(uri);
    this.lastPublishedDiagnostics.delete(uri);
    this.pendingDiagnosticsAfterInit.delete(uri);
    this.diagnosticsInFlight.delete(uri);
  }

  onFileEvent(method: string, uri: string): void {
    if (method !== "textDocument/didOpen" && method !== "textDocument/didChange" && method !== "textDocument/didSave") {
      return;
    }
    this.schedule(uri);
  }

  schedule(uri: string): void {
    if (!this.hasNonPullClients()) return;

    if (!this.initDone) {
      this.pendingDiagnosticsAfterInit.add(uri);
      return;
    }

    const existing = this.diagnosticDebounce.get(uri);
    if (existing) clearTimeout(existing);

    const delayMs = this.cfg.debounceMs ?? 150;
    const timer = setTimeout(() => {
      this.diagnosticDebounce.delete(uri);
      this.request(uri);
    }, delayMs);

    this.diagnosticDebounce.set(uri, timer);
  }

  request(uri: string): void {
    if (this.diagnosticsInFlight.has(uri)) return;
    if (!this.hasNonPullClients()) return;

    this.diagnosticsInFlight.add(uri);

    const msg =
      this.cfg.buildRequest?.(uri) ??
      ({
        jsonrpc: "2.0",
        method: "textDocument/diagnostic",
        params: { textDocument: { uri }, identifier: null, previousResultId: null },
      } as JsonRpcMessage);

    this.sendRequest(uri, msg);
  }

  onServerResponse(uri: string, msg: JsonRpcMessage): void {
    this.diagnosticsInFlight.delete(uri);
    const result = (msg as any).result;

    let diagnostics: unknown[] = [];
    if (result?.kind === "full" && Array.isArray(result.items)) {
      diagnostics = result.items;
    } else if (result?.kind === "unchanged") {
      diagnostics = this.lastPublishedDiagnostics.get(uri) ?? [];
    } else if (Array.isArray(result?.items)) {
      diagnostics = result.items;
    }

    this.lastPublishedDiagnostics.set(uri, diagnostics);
    if (!this.hasNonPullClients()) return;
    this.publish(uri, diagnostics);
  }
}
