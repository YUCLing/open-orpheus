import Emittery from "emittery";

import type {
  LifecycleEvents,
  LifecycleService,
} from "./bootstrap/services/lifecycle";

export { LifecycleState } from "./bootstrap/services/lifecycle";
export type { LifecycleEvents, LifecycleService };

// Created here rather than in the service: several modules subscribe at import
// time, which is before bootstrap runs.
export const events = new Emittery<LifecycleEvents>();

export let currentState: LifecycleService["currentState"];
export let setLifecycleState: LifecycleService["setLifecycleState"];

export function installLifecycleService(service: LifecycleService) {
  currentState = service.currentState;
  setLifecycleState = service.setLifecycleState;
}
