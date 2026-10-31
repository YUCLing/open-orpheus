export function checkEnvFlagPresent(name: string) {
  const val = process.env[name];
  return val === "1" || val === "true";
}
