export const channel =
  process.argv.find((v) => v.startsWith("--preload-channel="))?.substring(18) ?? null;
