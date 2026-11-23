/** Value of `--flag <value>`, or undefined when the flag is absent. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** Value of `--flag <value>`, throwing when the flag is absent or valueless. */
export function requireFlag(argv: string[], flag: string): string {
  const value = flagValue(argv, flag);
  if (!value) throw new Error(`Missing required flag: ${flag} <value>`);
  return value;
}

/** Whether a boolean flag is present. */
export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
