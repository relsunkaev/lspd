import path from "node:path";

import type { JsonRpcMessage } from "../lsp/framing";
import type { ServerSpec } from "./types";

function injectPullDiagnostics(msg: JsonRpcMessage): JsonRpcMessage {
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

async function nativePreviewBin(startDir: string): Promise<string | null> {
  const candidate = path.join(
    startDir,
    "node_modules",
    "@typescript",
    "native-preview",
    "bin",
    "tsgo.js",
  );
  try {
    await fsStat(candidate);
    return candidate;
  } catch {
    // ignore
  }

  return null;
}

async function fsStat(filePath: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.stat(filePath);
}

export const tsgoSpec: ServerSpec = {
  name: "tsgo",
  aliases: ["typescript-go"],
  binary: {
    args: ["--lsp", "-stdio"],
    envVar: "LSPD_TSGO_BIN",
    binaryNames: ["tsgo"],
    bunx: { package: "@typescript/native-preview", bin: "tsgo" },
    extraLocal: nativePreviewBin,
  },
  diagnostics: {
    mode: "pullToPushBridge",
    debounceMs: 150,
    buildRequest: (uri) =>
      ({
        jsonrpc: "2.0",
        method: "textDocument/diagnostic",
        params: { textDocument: { uri }, identifier: null, previousResultId: null },
      }) as JsonRpcMessage,
  },
  hooks: {
    prepareInitialize: injectPullDiagnostics,
  },
};
