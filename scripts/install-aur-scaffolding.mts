import { dirname, resolve } from "node:path";
import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const [, , srcArg, destArg] = process.argv;
if (!srcArg || !destArg) {
  throw new Error(
    "Usage: node scripts/install-aur-scaffolding.mts <src> <dest>"
  );
}

const src = resolve(srcArg);
const dest = resolve(destArg);

const { deb: debOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);

const icon = debOptions.icon
  ? resolve(projectRoot, debOptions.icon as string)
  : undefined;

const { Installer } = await import("electron-installer-debian");

const installer = new Installer({
  ...debOptions,
  icon,
  src,
  dest,
  arch: "noarch",
  logger: () => {},
});

await installer.generateDefaults();
await installer.generateOptions();
await installer.createStagingDir();

const contentFunctions = installer.contentFunctions.filter(
  (fn) => fn !== "createControl" && fn !== "copyScripts"
);
for (const fn of contentFunctions) {
  const fnImpl = (installer as unknown as Record<string, unknown>)[fn];
  if (typeof fnImpl !== "function") {
    throw new Error(`Installer function ${fn} is not available`);
  }
  await (fnImpl as () => Promise<void>).call(installer);
}

await mkdir(dest, { recursive: true });
for (const entry of await readdir(installer.stagingDir)) {
  await cp(resolve(installer.stagingDir, entry), resolve(dest, entry), {
    recursive: true,
  });
}

const bin = debOptions.bin ?? debOptions.name;
const usrBinDir = resolve(dest, "usr/bin");
await mkdir(usrBinDir, { recursive: true });
const symlinkPath = resolve(usrBinDir, bin);
await rm(symlinkPath, { force: true });
await symlink(`../lib/${installer.appIdentifier}/${bin}`, symlinkPath);

console.log(`Debian scaffolding generated from ${src} to ${dest}`);
