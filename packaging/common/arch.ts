import { arch as hostArch } from "node:process";

// Node/Electron arch names (`process.arch`, and Electron Forge's `targetArch`)
// differ from the names used by the native package formats. Each out directory
// is therefore named with the format's own spelling of the arch.

/** RPM arch names (`%{_arch}`). */
const RPM_ARCHS: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "i686",
  arm: "armv7hl",
};

/** Flatpak arch names. */
const FLATPAK_ARCHS: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "i386",
};

/** AppImage arch names (the ones in the `runtime-<arch>` filenames). */
const APPIMAGE_ARCHS: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "i686",
  arm: "armhf",
  armv7l: "armhf",
};

/** The Node/Electron arch name (`x64`) for `arch`, defaulting to the host arch. */
export function nodeArch(arch?: string): string {
  return arch ?? hostArch;
}

/** The RPM arch name (`x86_64`) for `arch`. Unknown arches pass through. */
export function rpmArch(arch?: string): string {
  return RPM_ARCHS[nodeArch(arch)] ?? nodeArch(arch);
}

/** The Flatpak arch name (`x86_64`) for `arch`. Unknown arches pass through. */
export function flatpakArch(arch?: string): string {
  return FLATPAK_ARCHS[nodeArch(arch)] ?? nodeArch(arch);
}

/** The AppImage arch name (`x86_64`) for `arch`. Unknown arches pass through. */
export function appimageArch(arch?: string): string {
  return APPIMAGE_ARCHS[nodeArch(arch)] ?? nodeArch(arch);
}
