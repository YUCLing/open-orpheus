import type Emittery from "emittery";
import type { Keyv } from "keyv";

import type { SettingsEvents } from "$sharedTypes/settings";
import type { SettingsService } from "./bootstrap/types";

export let kv: Keyv;
export let events: Emittery<SettingsEvents>;

export function installSettingsService(service: SettingsService) {
  kv = service.kv;
  events = service.events;
}
