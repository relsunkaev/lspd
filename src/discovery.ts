import fs from "node:fs/promises";
import path from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";
import childProcess from "node:child_process";

export type ServerName = "tsgo" | "oxlint";

export function lspArgs(server: ServerName): string[] {
  switch (server) {
    case "tsgo":
      // typescript-go uses `tsgo --lsp -stdio` (Go flag parsing).
      return ["--lsp", "-stdio"];
    case "oxlint":
      return ["--lsp"];
  }
}

export async function resolveProjectRoot(projectHint: string | undefined): Promise<string> {
  const hint = projectHint ?? process.cwd();
  const abs = path.isAbsolute(hint) ? hint : path.join(process.cwd(), hint);

  try {
    const stat = await fs.stat(abs);
    if (stat.isFile()) return path.dirname(abs);
    return abs;
  } catch {
    // If it doesn't exist yet, still treat it as a directory-ish hint.
    return abs;
  }
}

export async function findBinary(
  server: ServerName,
  startDir: string,
): Promise<{ cmd: string; args: string[] }> {
  const forced = server === "tsgo" ? process.env.LSPD_TSGO_BIN : process.env.LSPD_OXLINT_BIN;
  if (forced) return { cmd: forced, args: lspArgs(server) };

  const local = await findLocalBinary(server, startDir);
  if (local) return { cmd: local, args: lspArgs(server) };

  const global = findGlobalBinary(server);
  if (global) return { cmd: global, args: lspArgs(server) };

  // Fallback: install+run via bunx.
  // This keeps the mux functional even if the project hasn't installed the server.
  if (server === "tsgo") {
    return {
      cmd: "bunx",
      args: ["--package", "@typescript/native-preview", "tsgo", ...lspArgs(server)],
    };
  }

  return { cmd: "bunx", args: ["oxlint", ...lspArgs(server)] };
}

async function findLocalBinary(server: ServerName, startDir: string): Promise<string | null> {
  const binaryName = server;
  let current = startDir;

  // Walk up until filesystem root.
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", binaryName);
    if (await isExecutable(candidate)) return candidate;

    // Native-preview also provides bin/tsgo.js which can be invoked directly.
    if (server === "tsgo") {
      const previewBin = path.join(
        current,
        "node_modules",
        "@typescript",
        "native-preview",
        "bin",
        "tsgo.js",
      );
      if (await exists(previewBin)) {
        // Prefer going through the shim in node_modules/.bin when available,
        // but `tsgo.js` is better than network fetching.
        return previewBin;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function findGlobalBinary(server: ServerName): string | null {
  const name = server;
  const which = childProcess.spawnSync("which", [name], { encoding: "utf8" });
  if (which.status !== 0) return null;
  const first = which.stdout
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!first) return null;
  try {
    accessSync(first, fsConstants.X_OK);
    return first;
  } catch {
    return null;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
