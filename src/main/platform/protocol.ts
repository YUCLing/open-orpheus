import { app } from "electron";

export function checkOpenCommand(argv?: string[]): string | null {
  for (const arg of argv ?? process.argv) {
    if (arg.startsWith("orpheus://")) {
      return arg;
    }
  }
  return null;
}

export const isProtocolClient = () => app.isDefaultProtocolClient("orpheus");
export const getProtocolClientName = () =>
  app.getApplicationNameForProtocol("orpheus://");

export function unregisterAsProtocolClient() {
  if (!isProtocolClient()) return false;

  return app.removeAsDefaultProtocolClient("orpheus");
}

export default function registerAsProtocolClient(force = false) {
  if (isProtocolClient()) return false; // Already is

  if (!force && getProtocolClientName()) return false; // Some app is, and is not Open Orpheus & no force, skipping

  return app.setAsDefaultProtocolClient("orpheus");
}
