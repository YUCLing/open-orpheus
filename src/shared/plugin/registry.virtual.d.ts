declare module "virtual:open-orpheus/registry*" {
  export const load: Record<string, () => Promise<unknown>>;
  export const realm: string;
}
