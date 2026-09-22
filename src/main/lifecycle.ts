import Emittery from "emittery";

import {
  LifecycleState,
  type LifecycleEvents,
  type LifecycleService,
} from "./bootstrap/services/lifecycle";

export { LifecycleState };
export type { LifecycleEvents, LifecycleService };

// Created here rather than in the service: several modules subscribe at import
// time, which is before bootstrap runs.
export const events = new Emittery<LifecycleEvents>();

// Safe before `bootstrap()` runs: `main.ts` registers its app-level handlers at
// module load, and the pack loader can open a window before the root has installed
// the service. Reporting `Starting` is what those handlers would conclude anyway.
export let currentState: LifecycleService["currentState"] = () =>
  LifecycleState.Starting;
export let setLifecycleState: LifecycleService["setLifecycleState"] = () => {};

export function installLifecycleService(service: LifecycleService) {
  currentState = service.currentState;
  setLifecycleState = service.setLifecycleState;
}
