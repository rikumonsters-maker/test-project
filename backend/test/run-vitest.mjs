import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localWranglerConfigHome = resolve(backendRoot, ".wrangler", "xdg-config");
const vitestCli = resolve(backendRoot, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestCli, ...process.argv.slice(2)], {
	cwd: backendRoot,
	env: {
		...process.env,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || localWranglerConfigHome,
	},
	stdio: "inherit",
});

process.exitCode = result.status ?? 1;
