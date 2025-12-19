import { beforeAll, describe, expect, test } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { daemonDir } from "../src/config";
import { encodeMessage, readMessages, type JsonRpcMessage } from "../src/lsp/framing";

const repoRoot = path.resolve(import.meta.dir, "..");
const tsgoBuiltPath = path.join(repoRoot, "tmp", "tsgo-built");
const tsgoCloneDir = path.join(repoRoot, "tmp", "typescript-go");
const cliPath = path.join(repoRoot, "bin", "lspd");
const fixtureDir = path.join(repoRoot, "test-fixtures", "proj");
const filePath = path.join(fixtureDir, "src", "index.ts");
const fileUri = `file://${filePath}`;
const rootUri = `file://${fixtureDir}`;

beforeAll(async () => {
  // Install fixture deps once (native-preview + oxlint).
  const nodeModules = path.join(fixtureDir, "node_modules");
  try {
    await fs.stat(nodeModules);
  } catch {
    await runBun(["install"], fixtureDir, 600_000);
  }

  // Ensure we don't accidentally reuse a stale daemon from previous runs.
  await fs.rm(daemonDir("oxlint", fixtureDir), { recursive: true, force: true });
  await fs.rm(daemonDir("tsgo", fixtureDir), { recursive: true, force: true });

  // Ensure we have a working tsgo LSP binary.
  // The @typescript/native-preview package is intended to provide this, but in some
  // environments the shipped binary can hang. If so, build tsgo from source.
  const previewTsgo = path.join(fixtureDir, "node_modules", ".bin", "tsgo");
  const previewOk = await probeTsgo(previewTsgo);

  if (previewOk) {
    // Force the mux to use the exact local tsgo we just verified.
    process.env.LSPD_TSGO_BIN = previewTsgo;
  } else {
    await ensureTsgoBuilt();
    process.env.LSPD_TSGO_BIN = tsgoBuiltPath;
  }
});

describe("bun lspd smoke", () => {
  test("oxlint: initialize and diagnostics", async () => {
    const text = await fs.readFile(filePath, "utf8");
    const child = spawnConnect("oxlint");
    const iter = readMessages(child.stdout)[Symbol.asyncIterator]();

    write(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        capabilities: {
          textDocument: {
            diagnostic: {
              dynamicRegistration: false,
            },
          },
        },
      },
    });

    const initResp = await waitFor(iter, (m) => m.id === 1, 60_000);
    expect(initResp.result).toBeTruthy();

    write(child, { jsonrpc: "2.0", method: "initialized", params: {} });
    write(child, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: fileUri,
          languageId: "typescript",
          version: 1,
          text,
        },
      },
    });

    write(child, {
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: {
        textDocument: { uri: fileUri },
      },
    });

    // Some oxlint versions push diagnostics via publishDiagnostics,
    // while others support pull diagnostics (textDocument/diagnostic).
    write(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/diagnostic",
      params: {
        textDocument: { uri: fileUri },
        identifier: null,
        previousResultId: null,
      },
    });

    const diagMsg = await waitForAny(
      iter,
      [
        (m) => m.method === "textDocument/publishDiagnostics" && (m as any).params?.uri === fileUri,
        (m) => m.id === 2,
      ],
      30_000,
    );

    if (diagMsg.method === "textDocument/publishDiagnostics") {
      expect(Array.isArray((diagMsg as any).params?.diagnostics)).toBe(true);
      expect(((diagMsg as any).params?.diagnostics ?? []).length).toBeGreaterThan(0);
    } else {
      const err = (diagMsg as any).error;
      const res = (diagMsg as any).result;
      const items = pullDiagnosticItems(res);

      if (err || items == null) {
        const pushed = await waitFor(
          iter,
          (m) =>
            m.method === "textDocument/publishDiagnostics" && (m as any).params?.uri === fileUri,
          30_000,
        );
        expect(Array.isArray((pushed as any).params?.diagnostics)).toBe(true);
        expect(((pushed as any).params?.diagnostics ?? []).length).toBeGreaterThan(0);
      } else {
        expect(items.length).toBeGreaterThan(0);
      }
    }

    await shutdownChild(child);
  }, 90_000);

  test("tsgo: publishDiagnostics fallback for non-pull clients", async () => {
    const child = spawnConnect("tsgo");
    const iter = readMessages(child.stdout)[Symbol.asyncIterator]();

    // No diagnostic capability => mux should bridge pull->push.
    write(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        capabilities: {},
      },
    });

    const initResp = await waitFor(iter, (m) => m.id === 1, 30_000);
    expect(initResp.result).toBeTruthy();

    write(child, { jsonrpc: "2.0", method: "initialized", params: {} });
    write(child, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: fileUri,
          languageId: "typescript",
          version: 1,
          text: "const x: number = 'nope'\n",
        },
      },
    });

    write(child, {
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: {
        textDocument: { uri: fileUri },
      },
    });

    const diag = await waitFor(
      iter,
      (m) => m.method === "textDocument/publishDiagnostics" && (m as any).params?.uri === fileUri,
      30_000,
    );

    expect(Array.isArray((diag as any).params?.diagnostics)).toBe(true);
    expect(((diag as any).params?.diagnostics ?? []).length).toBeGreaterThan(0);

    await shutdownChild(child);
  }, 120_000);

  test("tsgo: multiplex pull diagnostics across clients", async () => {
    const text = await fs.readFile(filePath, "utf8");
    const child1 = spawnConnect("tsgo");
    const iter1 = readMessages(child1.stdout)[Symbol.asyncIterator]();

    write(child1, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        capabilities: {
          textDocument: {
            diagnostic: {
              dynamicRegistration: false,
            },
          },
        },
      },
    });

    const initResp = await waitFor(iter1, (m) => m.id === 1, 30_000);
    expect(initResp.result).toBeTruthy();

    write(child1, { jsonrpc: "2.0", method: "initialized", params: {} });
    write(child1, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: fileUri,
          languageId: "typescript",
          version: 1,
          text,
        },
      },
    });

    write(child1, {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/diagnostic",
      params: {
        textDocument: { uri: fileUri },
        identifier: null,
        previousResultId: null,
      },
    });

    const diagResp = await waitFor(iter1, (m) => m.id === 2, 30_000);
    assertPullDiagnosticsResponse(diagResp);

    // Second client should not re-initialize the server; it should get cached init.
    const child2 = spawnConnect("tsgo");
    const iter2 = readMessages(child2.stdout)[Symbol.asyncIterator]();

    write(child2, {
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        capabilities: {},
      },
    });

    const initResp2 = await waitFor(iter2, (m) => m.id === 99, 30_000);
    expect(initResp2.result).toBeTruthy();

    write(child2, { jsonrpc: "2.0", method: "initialized", params: {} });

    // Both clients issue a pull-diagnostics request with the same id.
    write(child1, {
      jsonrpc: "2.0",
      id: 42,
      method: "textDocument/diagnostic",
      params: {
        textDocument: { uri: fileUri },
        identifier: null,
        previousResultId: null,
      },
    });

    write(child2, {
      jsonrpc: "2.0",
      id: 42,
      method: "textDocument/diagnostic",
      params: {
        textDocument: { uri: fileUri },
        identifier: null,
        previousResultId: null,
      },
    });

    const resp1 = await waitFor(iter1, (m) => m.id === 42, 30_000);
    const resp2 = await waitFor(iter2, (m) => m.id === 42, 30_000);

    assertPullDiagnosticsResponse(resp1);
    assertPullDiagnosticsResponse(resp2);

    await shutdownChild(child2);
    await shutdownChild(child1);
  }, 150_000);
});

function spawnConnect(server: "tsgo" | "oxlint") {
  const child = childProcess.spawn(
    process.execPath,
    [cliPath, "connect", server, "--project", fixtureDir],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        LSPD_TEST: "1",
      },
    },
  );

  return child;
}

function write(child: childProcess.ChildProcessWithoutNullStreams, msg: JsonRpcMessage): void {
  child.stdin.write(encodeMessage(msg));
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

async function waitForAny(
  iter: AsyncIterator<JsonRpcMessage>,
  predicates: Array<(msg: JsonRpcMessage) => boolean>,
  timeoutMs: number,
): Promise<JsonRpcMessage> {
  return await waitFor(iter, (m) => predicates.some((p) => p(m)), timeoutMs);
}

function pullDiagnosticItems(res: any): unknown[] | null {
  if (!res || typeof res !== "object") return null;

  if ("kind" in res) {
    if ((res as any).kind === "full" && Array.isArray((res as any).items)) {
      return (res as any).items;
    }
    if ((res as any).kind === "unchanged") {
      return [];
    }
  }

  if (Array.isArray((res as any).items)) return (res as any).items;
  return null;
}

function assertPullDiagnosticsResponse(msg: JsonRpcMessage): void {
  const res = (msg as any).result;
  const items = pullDiagnosticItems(res);
  expect(items).not.toBe(null);
}

async function shutdownChild(child: childProcess.ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  child.kill();

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => resolve(), 2_000);
  });

  // Give the daemon (500ms idle timeout) time to exit.
  await sleep(700);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTsgoBuilt(): Promise<void> {
  try {
    await fs.stat(tsgoBuiltPath);
    return;
  } catch {
    // continue
  }

  // `tmp/` is gitignored (and empty dirs aren't cloned), so ensure it exists.
  await fs.mkdir(path.dirname(tsgoBuiltPath), { recursive: true });

  // Clone if missing.
  try {
    await fs.stat(tsgoCloneDir);
  } catch {
    await runCmd(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "https://github.com/microsoft/typescript-go.git",
        tsgoCloneDir,
      ],
      repoRoot,
      600_000,
    );
  }

  await runCmd(["go", "build", "-o", tsgoBuiltPath, "./cmd/tsgo"], tsgoCloneDir, 600_000);
}

async function probeTsgo(tsgoPath: string): Promise<boolean> {
  // Start tsgo LSP and send initialize; consider it OK if we get any response.
  try {
    await fs.stat(tsgoPath);
  } catch {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const child = childProcess.spawn(tsgoPath, ["--lsp", "-stdio"], {
      cwd: fixtureDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGKILL");
        resolve(false);
      }
    }, 3000);

    child.on("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(false);
      }
    });

    // Send initialize.
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        capabilities: {},
      },
    };
    write(child as any, init);

    (async () => {
      try {
        for await (const msg of readMessages(child.stdout)) {
          if (msg.id === 1 || msg.method === "window/logMessage") {
            if (!done) {
              done = true;
              clearTimeout(timer);
              child.kill("SIGKILL");
              resolve(true);
              return;
            }
          }
        }
      } catch {
        // ignore
      }
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(false);
      }
    })();
  });
}

async function runCmd(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(args[0]!, args.slice(1), {
      cwd,
      stdio: "inherit",
    });

    const to = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} timed out`));
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error(`${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function runBun(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return await runCmd([process.execPath, ...args], cwd, timeoutMs);
}
