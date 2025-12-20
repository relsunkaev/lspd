import type { ServerSpec } from "./types";

export const oxlintSpec: ServerSpec = {
  name: "oxlint",
  aliases: [],
  binary: {
    args: ["--lsp"],
    envVar: "LSPD_OXLINT_BIN",
    binaryNames: ["oxlint"],
    bunx: { package: "oxlint" },
  },
  diagnostics: { mode: "passthrough" },
};
