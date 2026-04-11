import { execFile as execFileCb } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const packagingDebDir = resolve(projectRoot, "packaging/deb");
const outDir = resolve(projectRoot, "out/make/ppa");
const sourcesDir = resolve(outDir, "SOURCES");

const pkg = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf-8")
) as {
  version: string;
  description?: string;
  license?: string;
  devDependencies?: { electron?: string };
  author?: { name?: string; email?: string } | string;
};

const { deb: debOptions } = (await import(
  new URL("../packaging/options.ts", import.meta.url).href
)) as {
  deb: {
    name: string;
    productName?: string;
    description?: string;
    homepage?: string;
    icon: string;
  };
};

type InstallerOptions = Record<string, unknown>;

type InstallerRuntimeOptions = {
  name?: unknown;
  version?: unknown;
  depends?: unknown;
};

type DebianInstallerLike = {
  options: InstallerRuntimeOptions;
  stagingDir: string;
  generateDefaults(): Promise<void>;
  generateOptions(): void;
  createStagingDir(): Promise<void>;
  copyLinuxIcons?(): Promise<void>;
  createBinarySymlink?(): Promise<void>;
  createCopyright?(): Promise<void>;
  createDesktopFile?(): Promise<void>;
  createOverrides?(): Promise<void>;
};

const { Installer } = (await import("electron-installer-debian")) as {
  Installer: new (options: InstallerOptions) => DebianInstallerLike;
};

const targetSeries = ["jammy", "noble"];

function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let output = template;
  for (const [key, value] of Object.entries(variables)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function sanitizeDescription(input: string | undefined): string {
  if (!input) return "An open-source Netease Cloud Music client.";
  return input.replace(/[\r\n]+/g, " ").trim();
}

function asMaintainer(
  author: { name?: string; email?: string } | string | undefined
): { full: string; name: string } {
  if (!author) {
    return {
      full: "Open Orpheus Maintainers <noreply@example.com>",
      name: "Open Orpheus Maintainers",
    };
  }

  if (typeof author === "string") {
    return {
      full: author,
      name: author.split("<")[0].trim() || "Open Orpheus Maintainers",
    };
  }

  const name = author.name || "Open Orpheus Maintainers";
  const email = author.email || "noreply@example.com";
  return { full: `${name} <${email}>`, name };
}

function rfc2822Now(): string {
  return new Date().toUTCString().replace("GMT", "+0000");
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
  try {
    await access(src);
    await cp(src, dest);
    return true;
  } catch {
    return false;
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(sourcesDir, { recursive: true });

const electronVersion = pkg.devDependencies?.electron;
if (!electronVersion) {
  throw new Error("electron version missing in package.json devDependencies");
}

const fakeAppDir = await mkdtemp(resolve(tmpdir(), "fake-electron-app-"));
await writeFile(resolve(fakeAppDir, "version"), electronVersion);
await mkdir(resolve(fakeAppDir, "resources/app"), { recursive: true });
await writeFile(
  resolve(fakeAppDir, "resources/app/package.json"),
  JSON.stringify({
    name: debOptions.name,
    version: pkg.version,
    description: debOptions.description,
    license: pkg.license,
    homepage: debOptions.homepage,
    productName: debOptions.productName,
  })
);
await writeFile(resolve(fakeAppDir, debOptions.name), "");
await cp(resolve(projectRoot, "LICENSE"), resolve(fakeAppDir, "LICENSE"));

const installer = new Installer({
  ...debOptions,
  icon: resolve(projectRoot, debOptions.icon),
  src: fakeAppDir,
  dest: outDir,
  arch: "amd64",
  logger: () => {},
});

await installer.generateDefaults();
await installer.generateOptions();
await installer.createStagingDir();

const scaffoldFunctions: Array<
  | "copyLinuxIcons"
  | "createBinarySymlink"
  | "createCopyright"
  | "createDesktopFile"
  | "createOverrides"
> = [
  "copyLinuxIcons",
  "createBinarySymlink",
  "createCopyright",
  "createDesktopFile",
  "createOverrides",
];

for (const fn of scaffoldFunctions) {
  const method = installer[fn];
  if (typeof method === "function") {
    await method.call(installer);
  }
}

const name = String(installer.options.name);
const version = String(installer.options.version);
const maintainer = asMaintainer(pkg.author);
const description = sanitizeDescription(debOptions.description || pkg.description);
const productName = debOptions.productName || name;

const projectOrigTarball = `${name}_${version}.orig.tar.gz`;
const scaffoldTarball = `${name}-${version}-deb-scaffolding.tar.gz`;

await execFile(
  "tar",
  [
    "czf",
    resolve(sourcesDir, projectOrigTarball),
    "--transform",
    `s,^\\.,${name}-${version},`,
    "--exclude=./node_modules",
    "--exclude=./out",
    "--exclude=./target",
    "--exclude=./data",
    "--exclude=./.git",
    "-C",
    projectRoot,
    ".",
  ],
  { maxBuffer: 10 * 1024 * 1024 }
);

await execFile("tar", [
  "czf",
  resolve(sourcesDir, scaffoldTarball),
  "-C",
  installer.stagingDir,
  "usr",
]);

await cp(resolve(sourcesDir, projectOrigTarball), resolve(outDir, projectOrigTarball));

const buildShTemplate = await readFile(
  resolve(packagingDebDir, "build.sh.in"),
  "utf-8"
);
const rulesTemplate = await readFile(resolve(packagingDebDir, "rules.in"), "utf-8");
const controlTemplate = await readFile(
  resolve(packagingDebDir, "control.in"),
  "utf-8"
);
const copyrightTemplate = await readFile(
  resolve(packagingDebDir, "copyright.in"),
  "utf-8"
);
const sourceFormat = await readFile(
  resolve(packagingDebDir, "source-format"),
  "utf-8"
);
const patchesSeries = await readFile(
  resolve(packagingDebDir, "patches-series"),
  "utf-8"
);

const workspaceDir = await mkdtemp(resolve(tmpdir(), "dsc-source-"));
await execFile("tar", [
  "xzf",
  resolve(sourcesDir, projectOrigTarball),
  "-C",
  workspaceDir,
]);

// dpkg-source for 3.0 (quilt) requires the orig tarball next to the source dir.
await cp(
  resolve(sourcesDir, projectOrigTarball),
  resolve(workspaceDir, projectOrigTarball)
);

const sourceRoot = resolve(workspaceDir, `${name}-${version}`);
const debianDir = resolve(sourceRoot, "debian");
await mkdir(resolve(debianDir, "source"), { recursive: true });
await mkdir(resolve(debianDir, "patches"), { recursive: true });

const buildDepends = "debhelper-compat (= 13), curl, ca-certificates, git, clang, make";
const binaryDepends = Array.isArray(installer.options.depends)
  ? installer.options.depends.join(", ")
  : "libgtk-3-0 | libgtk-4-1, libnotify4, libnss3, libxss1, libdbus-1-3, libatspi2.0-0, libasound2 | libasound2t64, libgbm1";

const variableMap = {
  NAME: name,
  PRODUCT_NAME: productName,
  DESCRIPTION: description,
  HOMEPAGE: debOptions.homepage || "https://github.com/YUCLing/open-orpheus",
  LICENSE: pkg.license || "MIT",
  MAINTAINER: maintainer.full,
  MAINTAINER_NAME: maintainer.name,
  COPYRIGHT_YEAR: String(new Date().getUTCFullYear()),
  BUILD_DEPENDS: buildDepends,
  BINARY_DEPENDS: binaryDepends,
  SCAFFOLD_TARBALL: scaffoldTarball,
};

await writeFile(resolve(debianDir, "build.sh"), renderTemplate(buildShTemplate, variableMap));
await chmod(resolve(debianDir, "build.sh"), 0o755);

await writeFile(resolve(debianDir, "rules"), renderTemplate(rulesTemplate, variableMap));
await chmod(resolve(debianDir, "rules"), 0o755);

await writeFile(
  resolve(debianDir, "control"),
  renderTemplate(controlTemplate, variableMap)
);
await writeFile(
  resolve(debianDir, "copyright"),
  renderTemplate(copyrightTemplate, variableMap)
);

await writeFile(resolve(debianDir, "source/format"), sourceFormat);
await writeFile(
  resolve(debianDir, "source/include-binaries"),
  `debian/${scaffoldTarball}\n`
);
await writeFile(resolve(debianDir, "patches/series"), patchesSeries);

await cp(resolve(sourcesDir, scaffoldTarball), resolve(debianDir, scaffoldTarball));

for (const series of targetSeries) {
  const debVersion = `${version}-1~${series}1`;
  const changelog = [
    `${name} (${debVersion}) ${series}; urgency=medium`,
    "",
    `  * Release ${version}.`,
    "",
    ` -- ${maintainer.full}  ${rfc2822Now()}`,
    "",
  ].join("\n");

  await writeFile(resolve(debianDir, "changelog"), changelog);

  await execFile("dpkg-buildpackage", ["-S", "-us", "-uc", "-d"], {
    cwd: sourceRoot,
    maxBuffer: 20 * 1024 * 1024,
  });

  const filesToCopy = [
    `${name}_${debVersion}.dsc`,
    `${name}_${debVersion}.debian.tar.xz`,
    `${name}_${debVersion}_source.changes`,
    `${name}_${debVersion}_source.buildinfo`,
  ];

  for (const file of filesToCopy) {
    await copyIfExists(resolve(workspaceDir, file), resolve(outDir, file));
  }
}

await rm(fakeAppDir, { recursive: true, force: true });
await rm(workspaceDir, { recursive: true, force: true });

const outputs = await readdir(outDir);
console.log("DSC artifacts created:");
for (const file of outputs) {
  if (file.endsWith(".dsc") || file.endsWith(".changes") || file.endsWith(".orig.tar.gz") || file.endsWith(".debian.tar.xz") || file.endsWith(".buildinfo")) {
    console.log(`  ${resolve(outDir, file)}`);
  }
}
