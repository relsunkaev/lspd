import { describe, expect, test } from "bun:test";

import { lspArgs } from "../src/discovery";
import { allServers, resolveServer, tsgoSpec } from "../src/servers";

describe("server registry", () => {
  test("resolves names and aliases", () => {
    const tsgo = resolveServer("tsgo");
    const alias = resolveServer("typescript-go");

    expect(tsgo).toBe(tsgoSpec);
    expect(alias).toBe(tsgoSpec);
  });

  test("allServers returns unique names", () => {
    const names = allServers().map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["tsgo", "oxlint"]));
  });

  test("lspArgs pulls from spec", () => {
    expect(lspArgs("tsgo")).toEqual(tsgoSpec.binary.args);
    expect(lspArgs("typescript-go")).toEqual(tsgoSpec.binary.args);
  });
});
