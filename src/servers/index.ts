import { oxlintSpec } from "./oxlint";
import { tsgoSpec } from "./tsgo";
import type { ServerSpec } from "./types";

const builtIns: ServerSpec[] = [tsgoSpec, oxlintSpec];

const byName = new Map<string, ServerSpec>();
for (const spec of builtIns) {
  byName.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) {
    byName.set(alias, spec);
  }
}

export function resolveServer(name: string): ServerSpec | null {
  return byName.get(name) ?? null;
}

export function allServers(): ServerSpec[] {
  return builtIns.slice();
}

export { tsgoSpec, oxlintSpec };
export type { ServerSpec } from "./types";
