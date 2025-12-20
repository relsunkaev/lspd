import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findBinary, lspArgs } from "../src/discovery";

let tmpDir: string;
let originalPath: string | undefined;
let originalTsgo: string | undefined;
let originalOxlint: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lspd-disc-"));
  originalPath = process.env.PATH;
  originalTsgo = process.env.LSPD_TSGO_BIN;
  originalOxlint = process.env.LSPD_OXLINT_BIN;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;

  if (originalTsgo === undefined) delete process.env.LSPD_TSGO_BIN;
  else process.env.LSPD_TSGO_BIN = originalTsgo;

  if (originalOxlint === undefined) delete process.env.LSPD_OXLINT_BIN;
  else process.env.LSPD_OXLINT_BIN = originalOxlint;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("findBinary", () => {
  test("prefers env override", async () => {
    const override = await makeExecutable(path.join(tmpDir, "override-tsgo"));
    process.env.LSPD_TSGO_BIN = override;
    process.env.PATH = "";

    const res = await findBinary("tsgo", tmpDir);

    expect(res.cmd).toBe(override);
    expect(res.args).toEqual(lspArgs("tsgo"));
  });

  test("finds local node_modules/.bin before global", async () => {
    const project = path.join(tmpDir, "proj");
    const local = await makeExecutable(path.join(project, "node_modules", ".bin", "tsgo"));
    process.env.PATH = "";
    delete process.env.LSPD_TSGO_BIN;

    const res = await findBinary("tsgo", project);

    expect(res.cmd).toBe(local);
    expect(res.args).toEqual(lspArgs("tsgo"));
  });

  test("falls back to native-preview bin when .bin shim is missing", async () => {
    const project = path.join(tmpDir, "preview-proj");
    const preview = path.join(
      project,
      "node_modules",
      "@typescript",
      "native-preview",
      "bin",
      "tsgo.js",
    );
    await makeExecutable(preview);
    process.env.PATH = "";
    delete process.env.LSPD_TSGO_BIN;

    const res = await findBinary("tsgo", project);

    expect(res.cmd).toBe(preview);
    expect(res.args).toEqual(lspArgs("tsgo"));
  });

  test("uses global binary when present on PATH", async () => {
    const globalDir = path.join(tmpDir, "global");
    const oxlint = await makeExecutable(path.join(globalDir, "oxlint"));
    process.env.PATH = [globalDir, originalPath ?? ""].filter(Boolean).join(path.delimiter);
    delete process.env.LSPD_OXLINT_BIN;

    const res = await findBinary("oxlint", tmpDir);

    expect(res.cmd).toBe(oxlint);
    expect(res.args).toEqual(lspArgs("oxlint"));
  });

  test("falls back to bunx when nothing is available", async () => {
    const project = path.join(tmpDir, "fallback");
    process.env.PATH = "";
    delete process.env.LSPD_TSGO_BIN;

    const res = await findBinary("tsgo", project);

    expect(res.cmd).toBe("bunx");
    expect(res.args).toEqual([
      "--package",
      "@typescript/native-preview",
      "tsgo",
      ...lspArgs("tsgo"),
    ]);
  });
});

async function makeExecutable(filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/usr/bin/env node\nprocess.exit(0);\n", {
    mode: 0o755,
  });
  return filePath;
}
