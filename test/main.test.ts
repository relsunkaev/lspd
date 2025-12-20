import { describe, expect, test } from "bun:test";

import { main } from "../src/main";

describe("main usage", () => {
  test("--help lists known servers", async () => {
    const output = await captureStderr(() => main(["--help"]));
    expect(output).toContain("tsgo");
    expect(output).toContain("oxlint");
    expect(output).toContain("lspd connect <");
  });
});

async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  let buffer = "";
  const originalWrite = process.stderr.write;
  (process.stderr as any).write = (chunk: any) => {
    buffer += chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as any).write = originalWrite;
  }
  return buffer;
}
