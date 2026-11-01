export interface SettingsContract {
  events: {
    change(callback: (key: string, value: unknown) => void): Promise<void>;
    delete(callback: (key: string) => void): Promise<void>;
  };
  get(key: string): Promise<unknown | undefined>;
  get(key: string[]): Promise<(unknown | undefined)[]>;
  set(key: string, value: unknown): Promise<boolean>;
  setMany(entries: { key: string; value: unknown }[]): Promise<boolean[]>;
  delete(key: string): Promise<boolean>;
  deleteMany(key: string[]): Promise<boolean[]>;
}
