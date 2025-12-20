import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { cacheDir, daemonDir, daemonMetaPath, daemonPidPath, daemonSocketPath } from "../config";
import { resolveProjectRoot, type ServerName } from "../discovery";
import { allServers, resolveServer } from "../servers";

type DaemonMeta = {
  server: ServerName;
  projectRoot: string;
  socketPath: string;
  updatedAt?: string;
};

export async function runPs(argv: string[]): Promise<void> {
  const json = argv.includes("--json");

  const entries = await listDaemonEntries();

  if (json) {
    process.stdout.write(JSON.stringify({ daemons: entries }, null, 2) + "\n");
    return;
  }

  if (entries.length === 0) {
    process.stdout.write("No lspd daemons found.\n");
    return;
  }

  for (const e of entries) {
    const status = e.socketAlive ? "listening" : e.pidAlive ? "running" : "stale";
    process.stdout.write(
      `${e.server ?? "?"}\tpid=${e.pid ?? "?"}\t${status}\t${e.projectRoot ?? "?"}\n`,
    );
  }
}

export async function runKill(argv: string[]): Promise<void> {
  const { all, server, project } = parseKillArgs(argv);

  const targets = all
    ? await listDaemonEntries()
    : [await entryFor(server!, await resolveProjectRoot(project))].filter(Boolean);

  if (targets.length === 0) {
    process.stderr.write(all ? "No daemons to kill.\n" : "No matching daemon found.\n");
    process.exitCode = 1;
    return;
  }

  let stopped = 0;
  for (const t of targets) {
    if (!t.pid) continue;
    const ok = await stopPid(t.pid);
    if (ok) stopped++;
  }

  process.stdout.write(`Stopped ${stopped} daemon(s).\n`);
}

export async function runPrune(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    throw new Error("Usage: lspd prune");
  }

  const entries = await listDaemonEntries();
  const stale = entries.filter((e) => !e.pidAlive && !e.socketAlive);

  if (stale.length === 0) {
    process.stdout.write("No stale daemons to prune.\n");
    return;
  }

  const daemonsRoot = path.join(cacheDir(), "daemons");
  let pruned = 0;

  for (const e of stale) {
    try {
      await fs.rm(path.join(daemonsRoot, e.id), { recursive: true, force: true });
      pruned++;
    } catch {
      // ignore
    }
  }

  process.stdout.write(`Pruned ${pruned} daemon(s).\n`);
}

function parseKillArgs(argv: string[]): {
  all: boolean;
  server?: ServerName;
  project?: string;
} {
  if (argv.includes("--all")) return { all: true };

  const [serverRaw, ...rest] = argv;
  const spec = serverRaw ? resolveServer(serverRaw) : null;
  if (!spec) {
    const names = allServers()
      .map((s) => s.name)
      .join("|");
    throw new Error(
      `Usage: lspd kill <server> [--project <path>] | lspd kill --all (known: ${names || "none"})`,
    );
  }

  let project: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--project") {
      project = rest[i + 1];
      i++;
    }
  }

  return { all: false, server: spec.name, project };
}

async function listDaemonEntries(): Promise<
  Array<{
    id: string;
    server: ServerName | null;
    projectRoot: string | null;
    socketPath: string;
    pid: number | null;
    pidAlive: boolean;
    socketAlive: boolean;
  }>
> {
  const daemonsRoot = path.join(cacheDir(), "daemons");

  let dirents: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirents = (await fs.readdir(daemonsRoot, { withFileTypes: true })) as any;
  } catch {
    return [];
  }

  const results: Array<{
    id: string;
    server: ServerName | null;
    projectRoot: string | null;
    socketPath: string;
    pid: number | null;
    pidAlive: boolean;
    socketAlive: boolean;
  }> = [];

  for (const d of dirents) {
    if (!d.isDirectory()) continue;

    const id = d.name;
    const dir = path.join(daemonsRoot, id);

    const { meta, pid } = await readMetaAndPid(dir);
    const pidAlive = pid != null ? isPidAlive(pid) : false;
    const socketPath = meta?.socketPath ?? path.join(dir, "daemon.sock");
    const socketAlive = await canConnect(socketPath);

    results.push({
      id,
      server: meta?.server ?? null,
      projectRoot: meta?.projectRoot ?? null,
      socketPath,
      pid,
      pidAlive,
      socketAlive,
    });
  }

  // Stable-ish ordering for human output.
  results.sort((a, b) => {
    const as = a.server ?? "";
    const bs = b.server ?? "";
    if (as !== bs) return as.localeCompare(bs);
    return (a.projectRoot ?? "").localeCompare(b.projectRoot ?? "");
  });

  return results;
}

async function entryFor(server: ServerName, projectRoot: string) {
  const dir = daemonDir(server, projectRoot);
  const socketPath = daemonSocketPath(server, projectRoot);

  const { meta, pid } = await readMetaAndPid(dir, server, projectRoot);
  const pidAlive = pid != null ? isPidAlive(pid) : false;
  const socketAlive = await canConnect(socketPath);

  return {
    id: path.basename(dir),
    server: meta?.server ?? server,
    projectRoot: meta?.projectRoot ?? projectRoot,
    socketPath,
    pid,
    pidAlive,
    socketAlive,
  };
}

async function readMetaAndPid(
  dir: string,
  server?: ServerName,
  projectRoot?: string,
): Promise<{ meta: DaemonMeta | null; pid: number | null }> {
  let meta: DaemonMeta | null = null;
  try {
    if (server && projectRoot) {
      meta = JSON.parse(await fs.readFile(daemonMetaPath(server, projectRoot), "utf8"));
    } else {
      meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    }
  } catch {
    // ignore
  }

  let pid: number | null = null;
  try {
    if (server && projectRoot) {
      pid = Number((await fs.readFile(daemonPidPath(server, projectRoot), "utf8")).trim());
    } else {
      pid = Number((await fs.readFile(path.join(dir, "daemon.pid"), "utf8")).trim());
    }
    if (!Number.isFinite(pid)) pid = null;
  } catch {
    // ignore
  }

  return { meta, pid };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(50);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }

  return !isPidAlive(pid);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
