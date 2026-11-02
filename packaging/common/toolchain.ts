/**
 * Pinned version of the build-time Rust toolchain the packagers and CI install.
 *
 * This is the single source of truth: the Flatpak sandbox vendors the toolchain
 * as an offline source, the deb/rpm source packages install the same version at
 * build time, and CI resolves it from here — so every consumer agrees.
 *
 * `wasm-bindgen` (Cargo.toml), Node (package.json `engines`) and pnpm
 * (`packageManager`) are deliberately absent: they are derived from the project
 * so they always track what it actually builds with.
 */

/** Rust toolchain installed by the packagers and CI. */
export const RUST_VERSION = "1.99.1";
