import { buildRpm } from "../../packaging/rpm/build.ts";
import { runPackagingCommand } from "./run.ts";

// Build the SRPM, then `rpmbuild --rebuild` it into binary RPMs.
// Output lands in `out/make/rpm/<rpmArch>`.
await runPackagingCommand("RPM(s) created", ({ projectRoot, flags, prebuilt }) =>
  buildRpm({
    projectRoot,
    installTools: flags.installTools,
    nodeps: flags.nodeps,
    prebuilt,
    arch: flags.arch,
    clean: flags.clean,
  })
);
