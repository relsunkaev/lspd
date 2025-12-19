import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "lspd");
}

export function daemonId(server: string, projectRoot: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(projectRoot)
    .update("\0")
    .update(server)
    .digest("hex");
  return hash.slice(0, 16);
}

export function daemonDir(server: string, projectRoot: string): string {
  return path.join(cacheDir(), "daemons", daemonId(server, projectRoot));
}

export function daemonSocketPath(server: string, projectRoot: string): string {
  return path.join(daemonDir(server, projectRoot), "daemon.sock");
}

export function daemonPidPath(server: string, projectRoot: string): string {
  return path.join(daemonDir(server, projectRoot), "daemon.pid");
}

export function daemonLogPath(server: string, projectRoot: string): string {
  return path.join(daemonDir(server, projectRoot), "daemon.log");
}

export function daemonMetaPath(server: string, projectRoot: string): string {
  return path.join(daemonDir(server, projectRoot), "meta.json");
}
