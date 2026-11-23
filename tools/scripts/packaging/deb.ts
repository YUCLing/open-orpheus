import { buildDeb } from "../../packaging/deb/source.ts";
import { runPackagingCommand } from "./run.ts";

// Build the binary .deb directly. Output lands in `out/make/deb/<arch>`.
await runPackagingCommand("DEB(s) created", ({ projectRoot, flags, prebuilt }) =>
  buildDeb({
    projectRoot,
    installTools: flags.installTools,
    nodeps: flags.nodeps,
    prebuilt,
    arch: flags.arch,
    clean: flags.clean,
  })
);
