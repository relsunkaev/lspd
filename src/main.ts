import { runConnect } from "./cli/connect";
import { runDaemon } from "./daemon/daemon";

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  switch (command) {
    case "connect":
      await runConnect(rest);
      return;
    case "daemon":
      await runDaemon(rest);
      return;
    default:
      usage();
      process.exitCode = 2;
      return;
  }
}

function usage(): void {
  // Keep it terse: this is usually run by editors.
  process.stderr.write(
    "Usage:\n" +
      "  lspd connect <tsgo|oxlint> [--project <path>]\n" +
      "\n" +
      "Internal:\n" +
      "  lspd daemon --server <name> --projectRoot <path> --socket <path>\n",
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
