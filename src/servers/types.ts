import type { JsonRpcMessage } from "../lsp/framing";

export type DiagnosticMode = "passthrough" | "pullToPushBridge";

export type DiagnosticsSpec = {
  mode: DiagnosticMode;
  debounceMs?: number;
  buildRequest?: (uri: string) => JsonRpcMessage;
};

export type BinarySpec = {
  /** Preferred CLI args for running the server in LSP/stdio mode. */
  args: string[];
  /** Environment variable that forces a binary path. */
  envVar?: string;
  /** Candidate binary names to search locally/globally. */
  binaryNames: string[];
  /** Optional bunx fallback. */
  bunx?: { package: string; bin?: string; args?: string[] };
  /** Extra project-local path probe beyond node_modules/.bin. */
  extraLocal?: (startDir: string) => Promise<string | null>;
};

export type ServerHooks = {
  /**
   * Optionally transform the initialize request sent to the server.
   * This is primarily used to inject capabilities.
   */
  prepareInitialize?: (msg: JsonRpcMessage) => JsonRpcMessage;
};

export type ServerSpec = {
  name: string;
  aliases?: string[];
  binary: BinarySpec;
  diagnostics?: DiagnosticsSpec;
  hooks?: ServerHooks;
};
