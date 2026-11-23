import { buildSrpm } from "../../packaging/rpm/srpm.ts";
import { runPackagingCommand } from "./run.ts";

// Build the arch-independent SRPM for Copr. Output lands in `out/make/srpm`.
await runPackagingCommand("SRPM(s) created", ({ projectRoot, flags, prebuilt }) =>
  buildSrpm({
    projectRoot,
    installTools: flags.installTools,
    nodeps: flags.nodeps,
    prebuilt,
    clean: flags.clean,
  })
);
