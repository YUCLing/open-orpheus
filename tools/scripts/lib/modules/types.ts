/** A workspace module discovered under `modules/`. */
export interface ModuleInfo {
  dirName: string;
  packageName: string;
  path: string;
  workspaceDeps: string[];
  scripts: Record<string, string>;
  os?: string[];
}

/** A module build whose script has been resolved and is ready to spawn. */
export interface BuildTask {
  module: ModuleInfo;
  /** Script name passed to `pnpm run`. */
  script: string;
  /** The command that script expands to, inspected to classify the build. */
  command: string;
}
