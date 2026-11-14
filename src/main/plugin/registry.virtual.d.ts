/**
 * The host imports the registry through a virtual module resolved by
 * `plugins/RegistryPlugin.ts` at build time. Declared here so tsc/oxlint can
 * type-check the host without generating anything.
 */
declare module "virtual:open-orpheus/registry" {
  export const load: Record<string, () => Promise<unknown>>;
}
