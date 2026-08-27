import { execFile as execFileCb } from "node:child_process";
import { resolve } from "node:path";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { createProjectTarball } from "../common/archive.ts";
import { createSpecFile } from "./spec.ts";

const execFile = promisify(execFileCb);

export interface BuildSrpmOptions {
  /** Project root. Defaults to the repository root. */
  projectRoot?: string;
  /** Directory that receives the `.src.rpm`. Defaults to `out/make/srpm`. */
  outDir?: string;
  /** Install the build toolchain (rust/node/pnpm) inside `%build`. Defaults to true. */
  installTools?: boolean;
  /** Pass `--nodeps` to rpmbuild to skip the build-dependency check. Defaults to false. */
  nodeps?: boolean;
}

/**
 * Build the arch-independent source RPM (SRPM) for Copr.
 *
 * Bundles the project source (Source0) and a generated spec, then runs
 * `rpmbuild -bs`. Returns the absolute paths of the produced SRPMs.
 */
export async function buildSrpm(
  options: BuildSrpmOptions = {}
): Promise<string[]> {
  const projectRoot =
    options.projectRoot ?? resolve(import.meta.dirname, "../..");
  const outDir = options.outDir ?? resolve(projectRoot, "out/make/srpm");

  const pkg = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf-8")
  );
  const { rpm: rpmOptions } = await import(
    resolve(projectRoot, "packaging/options.ts")
  );

  const name = rpmOptions.name;
  const version: string = pkg.version;
  const release = "1%{?dist}";

  // --- Step 1: Resolve versions injected into the spec ---
  const nodeVersion = String(
    (pkg.engines?.node ?? "").match(/\d+/)?.[0] ?? "24"
  );
  const cargoToml = await readFile(resolve(projectRoot, "Cargo.toml"), "utf-8");
  const wasmBindgen = cargoToml.match(
    /^\s*wasm-bindgen\s*=\s*["']([^"']+)["']/m
  )?.[1];
  if (!wasmBindgen) {
    throw new Error("Cannot find wasm-bindgen version in Cargo.toml.");
  }
  const changelog = `${new Date().toString().slice(0, 15)} ${
    pkg.author?.name ?? ""
  } <${pkg.author?.email ?? ""}>`;

  // --- Step 2: Set up the rpmbuild topdir layout ---
  const buildDir = resolve(outDir, "BUILD");
  const rpmsDir = resolve(outDir, "RPMS");
  const sourcesDir = resolve(outDir, "SOURCES");
  const specsDir = resolve(outDir, "SPECS");
  const srpmsDir = resolve(outDir, "SRPMS");
  await Promise.all(
    [buildDir, rpmsDir, sourcesDir, specsDir, srpmsDir].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );

  const projectTarball = `${name}-${version}.tar.gz`;

  // --- Step 3: Project source tarball (Source0) ---
  await createProjectTarball(
    projectRoot,
    resolve(sourcesDir, projectTarball),
    name,
    version
  );

  // --- Step 4: Generate the spec ---
  const specPath = resolve(specsDir, `${name}.spec`);
  await createSpecFile(specPath, {
    name,
    version,
    release,
    summary: rpmOptions.description ?? pkg.description,
    description: pkg.description,
    license: rpmOptions.license ?? pkg.license,
    homepage: rpmOptions.homepage ?? pkg.homepage,
    nodeVersion,
    wasmBindgen,
    changelog,
    installTools: options.installTools,
  });

  // --- Step 5: Build the SRPM ---
  const rpmbuildArgs = ["--define", `_topdir ${outDir}`, "-bs"];
  if (options.nodeps) rpmbuildArgs.push("--nodeps");
  rpmbuildArgs.push(specPath);
  await execFile("rpmbuild", rpmbuildArgs);

  // --- Step 6: Collect the SRPM and clean up ---
  const srpms = await readdir(srpmsDir);
  await Promise.all(
    srpms.map((f) => cp(resolve(srpmsDir, f), resolve(outDir, f)))
  );
  await Promise.all(
    [buildDir, rpmsDir, sourcesDir, specsDir, srpmsDir].map((dir) =>
      rm(dir, { recursive: true, force: true })
    )
  );

  return srpms.map((f) => resolve(outDir, f));
}
