import { app } from "electron";

export const isProtocolClient = () => app.isDefaultProtocolClient("orpheus");
export const getProtocolClientName = () => app.getApplicationNameForProtocol("orpheus://");

export function unregisterAsProtocolClient() {
  if (!isProtocolClient()) return false;

  const removed = app.removeAsDefaultProtocolClient("orpheus");
  if (removed) LOGGER.info("Unregistered as the default orpheus:// protocol client");
  return removed;
}

export default function registerAsProtocolClient(force = false) {
  if (isProtocolClient()) return false; // Already is

  if (!force && getProtocolClientName()) return false; // Some app is, and is not Open Orpheus & no force, skipping

  const registered = app.setAsDefaultProtocolClient("orpheus");
  if (registered) {
    LOGGER.info("Registered as the default orpheus:// protocol client");
  } else {
    LOGGER.warn("Failed to register as the default orpheus:// protocol client");
  }
  return registered;
}
