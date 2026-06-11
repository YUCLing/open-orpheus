import { dirname, resolve } from "node:path";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const { flatpak: flatpakOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);

const appDir = process.argv[2];
if (!appDir) {
  throw new Error(
    "Usage: node install-flatpak-scaffolding.mts <packaged-app-dir>"
  );
}
console.log(`Using packaged app directory: ${appDir}`);

const tempOutputDir = await mkdtemp(resolve(tmpdir(), "flatpak-scaffold-out-"));

const { Installer } = await import("@malept/electron-installer-flatpak");

const installer = new Installer({
  ...flatpakOptions,
  icon: flatpakOptions.icon
    ? resolve(projectRoot, flatpakOptions.icon as string)
    : undefined,
  src: appDir,
  dest: tempOutputDir,
  arch: "noarch",
  logger: () => {},
});

await installer.generateDefaults();
await installer.generateOptions();
await installer.createStagingDir();

for (const fn of installer.contentFunctions) {
  if (fn === "copyApplication") continue;
  await (installer[fn] as () => Promise<void>)();
}

// Process the `files` option explicitly because createBundle() is not run.
for (const [src, dest] of (flatpakOptions.files ?? []) as [string, string][]) {
  const srcAbs = resolve(projectRoot, src);
  const destAbs = resolve(
    installer.stagingDir,
    installer.baseAppDir,
    dest.replace(/^\//, "")
  );
  await mkdir(dirname(destAbs), { recursive: true });
  await cp(srcAbs, destAbs);
}

await mkdir("/app", { recursive: true });
for (const entry of await readdir(installer.stagingDir)) {
  await cp(resolve(installer.stagingDir, entry), resolve("/app", entry), {
    recursive: true,
  });
}

await rm(tempOutputDir, { recursive: true, force: true });

console.log("Flatpak scaffolding installed to /app");
