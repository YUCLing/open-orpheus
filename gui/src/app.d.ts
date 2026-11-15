import "../../src/shared/plugin/realm.virtual.d.ts";
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  const __APP_VERSION__: string;
}

export {};
