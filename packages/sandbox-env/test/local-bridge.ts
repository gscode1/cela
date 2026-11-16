// Test-only bridge executable: the real runBridge, but "the sandbox" is a local pi-env daemon.
// Run by pi-env's Connection as `node local-bridge.ts serve --token <hex>`.
import { localDaemon } from "@earendil-works/pi-env";
import { runBridge } from "../src/bridge.ts";
import { localStart } from "./local-start.ts";

const code = await runBridge({
  start: localStart(),
  command: localDaemon(),
  args: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
