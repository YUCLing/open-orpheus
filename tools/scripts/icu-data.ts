#!/usr/bin/env node

import { cmdBuild, cmdVersion } from "./lib/icu/build.ts";
import {
  die,
  parseArgv,
  parseBuildOptions,
  parseVersionOptions,
  printUsage,
} from "./lib/icu/cli.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const args = parseArgv(argv);

  switch (args.command) {
    case "version": {
      await cmdVersion(parseVersionOptions(args));
      break;
    }
    case "build": {
      await cmdBuild(parseBuildOptions(args));
      break;
    }
    default: {
      console.error(`ERROR: Unknown command: ${args.command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  die(message);
});
