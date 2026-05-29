import Emittery from "emittery";

import type { SettingsEvents } from "$sharedTypes/settings";
import type { SettingsContract } from "$bridge/contracts/settings-api";

import { getBridge } from "./bridge";

const api = getBridge<SettingsContract>("settings");

const emitter = new Emittery<SettingsEvents>();

api.events.change((key, value) => {
  emitter.emit("change", { key, value });
});

api.events.delete((key) => {
  emitter.emit("delete", { key });
});

export async function get(key: string): Promise<unknown | undefined>;
export async function get(key: string[]): Promise<(unknown | undefined)[]>;
export async function get(
  key: string | string[]
): Promise<unknown | (unknown | undefined)[] | undefined> {
  return await api.get(key as string);
}

export async function set(key: string, value: unknown): Promise<boolean> {
  return await api.set(key, value);
}

export async function setMany(
  entries: { key: string; value: unknown }[]
): Promise<boolean[]> {
  return await api.setMany(entries);
}

export async function del(key: string | string[]): Promise<boolean> {
  return await api.delete(key);
}

export const events = emitter;

export default {
  get,
  set,
  setMany,
  delete: del,
  events: emitter,
};
