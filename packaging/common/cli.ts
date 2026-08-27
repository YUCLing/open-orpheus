export interface CliOptions {
  /** Install the build toolchain inside the package build. Defaults to false. */
  installTools: boolean;
  /** Skip the build-dependency check. Defaults to false. */
  nodeps: boolean;
  /** Reuse the prebuilt packaged Electron app instead of compiling. Defaults to false. */
  prebuilt: boolean;
  /** Architecture of the prebuilt app variant (e.g. `x64`, `arm64`). */
  arch?: string;
}

/**
 * Parse the shared packaging CLI flags:
 * `--install-tools`, `--nodeps`, `--prebuilt`, `--arch <arch>`.
 */
export function parseFlags(argv: string[]): CliOptions {
  const options: CliOptions = {
    installTools: false,
    nodeps: false,
    prebuilt: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--install-tools") options.installTools = true;
    else if (arg === "--nodeps") options.nodeps = true;
    else if (arg === "--prebuilt") options.prebuilt = true;
    else if (arg === "--arch") options.arch = argv[++i];
  }
  return options;
}
