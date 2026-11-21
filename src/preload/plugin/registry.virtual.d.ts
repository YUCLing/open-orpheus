declare module "virtual:open-orpheus/registry/preload" {
  export const load: Record<string, () => Promise<unknown>>;
}
