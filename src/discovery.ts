import childProcess from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { allServers, resolveServer, type ServerSpec } from "./servers";

const execFile = promisify(childProcess.execFile);

export type ServerName = string;

export function lspArgs(server: ServerName): string[] {
  const spec = resolveServer(server);
  if (!spec) throw new Error(`Unknown server '${server}'`);
  return spec.binary.args;
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
  const spec = resolveServer(server);
  if (!spec) {
    const known = allServers().map((s) => s.name).join("|");
    throw new Error(`Unknown server '${server}' (known: ${known || "none"})`);
  }

  return await findBinaryForSpec(spec, startDir);
}

export async function findBinaryForSpec(
  spec: ServerSpec,
  startDir: string,
): Promise<{ cmd: string; args: string[] }> {
  const forced = spec.binary.envVar ? process.env[spec.binary.envVar] : undefined;
  if (forced) return { cmd: forced, args: spec.binary.args };

  const local = await findLocalBinary(spec, startDir);
  if (local) return { cmd: local, args: spec.binary.args };

  const global = await findGlobalBinary(spec);
  if (global) return { cmd: global, args: spec.binary.args };

  const bunx = spec.binary.bunx;
  if (bunx) {
    const bin = bunx.bin ?? spec.name;
    const bunxArgs = bunx.args ?? [];
    return { cmd: "bunx", args: ["--package", bunx.package, bin, ...bunxArgs, ...spec.binary.args] };
  }

  throw new Error(`Unable to resolve binary for server '${spec.name}'`);
}

async function findLocalBinary(spec: ServerSpec, startDir: string): Promise<string | null> {
  let current = startDir;

  while (true) {
    for (const binaryName of spec.binary.binaryNames) {
      const candidate = path.join(current, "node_modules", ".bin", binaryName);
      if (await isExecutable(candidate)) return candidate;
    }

    if (spec.binary.extraLocal) {
      const extra = await spec.binary.extraLocal(current);
      if (extra) return extra;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

const globalBinaryCache = new Map<string, string | null>();

async function findGlobalBinary(spec: ServerSpec): Promise<string | null> {
  if (globalBinaryCache.has(spec.name)) return globalBinaryCache.get(spec.name)!;

  for (const name of spec.binary.binaryNames) {
    try {
      const { stdout } = await execFile("which", [name], { encoding: "utf8" });
      const first = stdout
        .split("\n")
        .map((s) => s.trim())
        .find(Boolean);
      if (!first) continue;
      try {
        await fs.access(first, fsConstants.X_OK);
        globalBinaryCache.set(spec.name, first);
        return first;
      } catch {
        // ignore and keep searching
      }
    } catch {
      // ignore and keep searching
    }
  }

  globalBinaryCache.set(spec.name, null);
  return null;
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
