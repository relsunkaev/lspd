Current Tight Coupling

  - ServerName union and CLI parsing are hardcoded to tsgo|oxlint (src/discovery.ts, src/cli/connect.ts, src/cli/manage.ts, src/daemon/daemon.ts), so nothing else can be addressed without edits.
  - Binary resolution and args are bespoke per server (findBinary, lspArgs, env vars LSPD_TSGO_BIN/LSPD_OXLINT_BIN in src/discovery.ts).
  - Mux logic has inline tsgo-specific behavior (pull-diagnostic bridge, init capability tweak) in src/daemon/daemon.ts guarded by if (this.server !== "tsgo").
  - Tests/README only exercise/describe these two servers.

  Server Registry Shape

  - Introduce a ServerSpec interface and a registry map, e.g. src/servers/index.ts, that provides everything currently hardcoded:
      - name, aliases
      - resolveBinary(opts): {cmd, args}
      - initTransform?(msg), onClientNotification?, onServerResponse?, onServerRequest?
      - diagnostics?: { mode: "passthrough" | "pullToPushBridge"; buildRequest?(uri) }
      - envVars?: Record<string,string> and optional bunx fallback/package metadata.
  - Move tsgo/oxlint into src/servers/tsgo.ts and src/servers/oxlint.ts implementing the spec. Their special behaviors (pull->push bridge, capability injection) live behind hooks instead of if (server ===
    "tsgo") checks.
  - CLI/daemon parsing becomes table-driven (registry.get(name)) instead of a union; error messages enumerate registered names.

  Pluggable Surface

  - Core mux (MuxState) works against a ServerSpecHooks object supplied at construction; it calls hooks when it currently does inline checks:
      - maybeTriggerDiagnostics, onInitResponse, onClientInit, onBroadcast etc.
      - A small DiagnosticsBridge helper could be a plugin instance owned by the spec to keep mux core generic.
  - findBinary becomes generic: read env overrides from spec.envVars, try spec.binaryNames locally/globally, fall back to spec.bunx.
  - runConnect/runStop/runLsps read valid server ids from the registry; usage() prints them dynamically.

  Config/Plugin Loading

  - Default bundled specs (tsgo, oxlint) exported from src/servers/index.ts.
  - Optional user extension points:
      1. Config file lspd.config.{json,ts} that exports ServerSpec[].
      2. Plugin discovery via node_modules/lspd-server-* packages exporting specs.
      3. Per-project lspds.d/*.mjs folder for experiments.
  - Merge order: built-ins < global config < project config; disallow name collisions unless explicitly overridden.

  Incremental Refactor Steps

  - Extract registry + specs; update discovery/cli/daemon to consume ServerSpec instead of unions.
  - Carve out tsgo diagnostics bridge into a DiagnosticsBridge class supplied by the tsgo spec; mux only calls hook methods.
  - Add a light contract test for registry lookup and binary resolution; adjust smoke tests to read names from registry to keep coverage.
  - Update README to describe registration/config and new CLI help text.

  Example Spec Skeleton

  // src/servers/tsserver.ts
  export const tsserverSpec: ServerSpec = {
    name: "tsserver",
    aliases: ["typescript-language-server"],
    binaryNames: ["typescript-language-server"],
    resolveArgs: () => ["--stdio"],
    diagnostics: { mode: "passthrough" },
  };

  Open Decisions

  - How opinionated to be about binary installation (always allow bunx fallback or make it opt-in per spec)?
  - Should per-server stateful hooks be class instances (for caching, debouncing) or pure functions receiving a context object?
  - Do we support Windows named pipes immediately or keep Unix sockets and document limitations?

  This path keeps the mux core focused on transport/routing while letting server-specific behavior live in swappable specs, making it easy to add new LSPs or ship them as plugins.
