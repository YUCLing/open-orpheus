import { buildDebSource } from "../../packaging/deb/source.ts";
import { runPackagingCommand } from "./run.ts";

// Build the Debian source package (.dsc + .orig.tar.gz + .debian.tar.xz) for a
// PPA. Output lands in `out/make/deb-src`.
await runPackagingCommand("Debian source package created", ({ projectRoot, flags, prebuilt }) =>
  buildDebSource({
    projectRoot,
    installTools: flags.installTools,
    nodeps: flags.nodeps,
    prebuilt,
    clean: flags.clean,
  })
);
