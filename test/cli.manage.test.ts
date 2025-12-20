import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { daemonDir, daemonMetaPath, daemonPidPath, daemonSocketPath } from "../src/config";
import { runKill, runPrune, runPs } from "../src/cli/manage";

let originalHome: string | undefined;
let tmpHome: string;
let originalHomedir: () => string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalHomedir = os.homedir;
  const tmpRoot = path.join(process.cwd(), "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  tmpHome = await fs.mkdtemp(path.join(tmpRoot, "cli-"));
  process.env.HOME = tmpHome;
  // Isolate cacheDir() to the temp HOME.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  (os as any).homedir = () => tmpHome;
});

afterEach(async () => {
  (os as any).homedir = originalHomedir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (process.env.KEEP_LSPD_TEST_ARTIFACTS === "1") return;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("cli manage", () => {
  test("ps prints none when empty", async () => {
    const out = await captureStdout(() => runPs([]));
    expect(out).toContain("No lspd daemons found.");
  });

  test("ps --json lists daemons", async () => {
    const proj = path.join(tmpHome, "proj");
    await createDaemon("tsgo", proj, 999_999);
    await createDaemon("oxlint", proj, 999_998);

    const out = await captureStdout(() => runPs(["--json"]));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.daemons)).toBe(true);
    expect(parsed.daemons.length).toBe(2);
    expect(parsed.daemons.map((d: any) => d.server).sort()).toEqual(["oxlint", "tsgo"]);
  });

  test("kill --all reports stopped count", async () => {
    const proj = path.join(tmpHome, "proj");
    await createDaemon("tsgo", proj, 999_997);
    await createDaemon("oxlint", proj, 999_996);

    const out = await captureStdout(() => runKill(["--all"]));
    expect(out.trim()).toBe("Stopped 2 daemon(s).");
  });

  test("prune removes stale daemon dirs", async () => {
    const proj = path.join(tmpHome, "proj");
    await createDaemon("tsgo", proj, 999_995);
    await createDaemon("oxlint", proj, 999_994);

    const tsgoDir = daemonDir("tsgo", proj);
    const oxlintDir = daemonDir("oxlint", proj);

    const out = await captureStdout(() => runPrune([]));
    expect(out.trim()).toBe("Pruned 2 daemon(s).");

    await expect(fs.access(tsgoDir)).rejects.toBeTruthy();
    await expect(fs.access(oxlintDir)).rejects.toBeTruthy();
  });

  test("prune reports none when clean", async () => {
    const out = await captureStdout(() => runPrune([]));
    expect(out.trim()).toBe("No stale daemons to prune.");
  });
});

async function createDaemon(server: string, projectRoot: string, pid: number): Promise<void> {
  const dir = daemonDir(server, projectRoot);
  await fs.mkdir(dir, { recursive: true });

  const socketPath = daemonSocketPath(server, projectRoot);
  const metaPath = daemonMetaPath(server, projectRoot);
  const pidPath = daemonPidPath(server, projectRoot);

  await fs.writeFile(
    metaPath,
    JSON.stringify({ server, projectRoot, socketPath, updatedAt: new Date().toISOString() }),
  );
  await fs.writeFile(pidPath, String(pid));
  // Ensure the daemon root exists even if socket isn't present.
  await fs.writeFile(path.join(dir, "placeholder"), "");
}

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  let buffer = "";
  const originalWrite = process.stdout.write;
  (process.stdout as any).write = (chunk: any) => {
    buffer += chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as any).write = originalWrite;
  }
  return buffer;
}
