import { spawn } from "node:child_process";

/** Run a command, streaming its output to the parent process. */
export function runStreaming(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export interface BuildCommandResult {
  status: number | null;
}

/**
 * Run a package script through pnpm.
 *
 * Invoking pnpm (rather than a package's `node_modules/.bin` shim) lets pnpm
 * resolve local binaries and handles Windows `.cmd` shims for us.
 */
export function runBuildCommand(cwd: string, script: string): Promise<BuildCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", script], {
      cwd,
      stdio: "inherit",
      // pnpm is an executable on POSIX; Windows needs the shell for pnpm.cmd.
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status }));
  });
}
