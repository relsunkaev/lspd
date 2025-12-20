import childProcess from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  daemonDir,
  daemonLogPath,
  daemonMetaPath,
  daemonPidPath,
  daemonSocketPath,
} from "../config";
import { resolveProjectRoot, type ServerName } from "../discovery";
import { allServers, resolveServer } from "../servers";

export async function runConnect(argv: string[]): Promise<void> {
  const { server, project } = parseConnectArgs(argv);
  const projectRoot = await resolveProjectRoot(project);

  const socketPath = daemonSocketPath(server, projectRoot);
  await ensureDaemonRunning(server, projectRoot);

  await proxyStdioToSocket(socketPath);
}

function parseConnectArgs(argv: string[]): { server: ServerName; project: string | undefined } {
  const [serverRaw, ...rest] = argv;
  const spec = serverRaw ? resolveServer(serverRaw) : null;
  if (!spec) {
    const names = allServers().map((s) => s.name).join("|");
    throw new Error(`Unknown server '${serverRaw ?? ""}' (known: ${names || "none"})`);
  }

  let project: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--project") {
      project = rest[i + 1];
      i++;
      continue;
    }
  }

  return { server: spec.name, project };
}

async function ensureDaemonRunning(server: ServerName, projectRoot: string): Promise<void> {
  const dir = daemonDir(server, projectRoot);
  await fs.mkdir(dir, { recursive: true });

  const socketPath = daemonSocketPath(server, projectRoot);

  await fs.writeFile(
    daemonMetaPath(server, projectRoot),
    JSON.stringify(
      { server, projectRoot, socketPath, updatedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );

  if (await canConnect(socketPath)) return;

  // In tests, keep the daemon attached so failures surface.
  const testMode = process.env.LSPD_TEST === "1";

  // Best-effort lock: create pid file exclusively.
  // If it exists, someone else is likely starting.
  const pidPath = daemonPidPath(server, projectRoot);
  const lockPath = `${pidPath}.lock`;

  let lockFd: fs.FileHandle | null = null;
  try {
    lockFd = await fs.open(lockPath, "wx");
  } catch {
    // Someone else is starting it; just wait.
    // In tests, also tolerate stale lock files from previous runs.
    if (testMode) {
      try {
        await fs.rm(lockPath, { force: true });
        lockFd = await fs.open(lockPath, "wx");
      } catch {
        // ignore
      }
    }
  }

  if (lockFd) {
    try {
      await spawnDaemon(server, projectRoot, { testMode });
    } finally {
      await lockFd.close();
      await fs.rm(lockPath, { force: true });
    }
  }

  // Wait for daemon to start.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await canConnect(socketPath)) return;
    await delay(50);
  }

  throw new Error(`Timed out waiting for daemon socket at ${socketPath}`);
}

async function spawnDaemon(
  server: ServerName,
  projectRoot: string,
  opts: { testMode: boolean },
): Promise<void> {
  const socketPath = daemonSocketPath(server, projectRoot);
  const logPath = daemonLogPath(server, projectRoot);
  const pidPath = daemonPidPath(server, projectRoot);

  const mainFile = path.resolve(import.meta.dir, "..", "main.ts");

  if (opts.testMode) {
    const child = childProcess.spawn(
      process.execPath,
      [
        mainFile,
        "daemon",
        "--server",
        server,
        "--projectRoot",
        projectRoot,
        "--socket",
        socketPath,
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        detached: false,
      },
    );

    await fs.writeFile(pidPath, String(child.pid));
    return;
  }

  const out = await fs.open(logPath, "a");

  const child = childProcess.spawn(
    process.execPath,
    [mainFile, "daemon", "--server", server, "--projectRoot", projectRoot, "--socket", socketPath],
    {
      // Using file descriptors here is convenient for debugging.
      // If detached spawning proves flaky, switch to stdio: "ignore" and log from the daemon.
      stdio: ["ignore", out.fd, out.fd],
      detached: true,
    },
  );

  child.unref();
  await fs.writeFile(pidPath, String(child.pid));
  await out.close();
}

async function proxyStdioToSocket(socketPath: string): Promise<void> {
  const socket = net.createConnection(socketPath);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", (err) => reject(err));
  });

  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  await new Promise<void>((resolve) => {
    socket.on("close", () => resolve());
    socket.on("end", () => resolve());
  });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
