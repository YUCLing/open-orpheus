import { parseFlags, type CliOptions } from "../../packaging/common/cli.ts";
import { readPackageJson } from "../../packaging/common/package-json.ts";
import { resolvePrebuiltAppDir } from "../../packaging/common/prebuilt.ts";
import { PROJECT_ROOT } from "../../shared/paths.ts";

export interface PackagingInvocation {
  projectRoot: string;
  flags: CliOptions;
  /** Absolute prebuilt app directory, present only with `--prebuilt`. */
  prebuilt?: string;
}

/**
 * Run one of the packaging CLI entry points.
 *
 * Every format parses the same flags, resolves the same optional prebuilt app,
 * delegates to its builder, and prints the produced artifacts — so that shared
 * flow lives here instead of being copied into each script.
 */
export async function runPackagingCommand(
  label: string,
  build: (invocation: PackagingInvocation) => Promise<string[]>
): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = PROJECT_ROOT;
  const prebuilt = flags.prebuilt
    ? await resolvePrebuiltAppDir(
        projectRoot,
        (await readPackageJson(projectRoot)).name,
        flags.arch
      )
    : undefined;

  const artifacts = await build({ projectRoot, flags, prebuilt });

  console.log(`${label}:`);
  for (const artifact of artifacts) {
    console.log(`  ${artifact}`);
  }
}
