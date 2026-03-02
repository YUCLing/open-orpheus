// The Rust addon.
import * as addon from "./load.cjs";

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function createConnection(path: string): number;
  function executeSql(
    ptr: number,
    sql: string
  ): [number, Record<string, string>[], [number, number, number]];
  function executeTransaction(
    ptr: number,
    sql: string
  ): [number, Record<string, string>[], [number, number, number]];
  function executeSqls(
    ptr: number,
    sqls: string[]
  ): {
    value: unknown[] | undefined;
  };
}

export default class Database {
  private _ptr: number;

  constructor(path: string) {
    this._ptr = addon.createConnection(path);
    if (this._ptr === 0) {
      throw new Error(`Failed to create database connection for path: ${path}`);
    }
  }

  executeSql(sql: string): ReturnType<typeof addon.executeSql> {
    return addon.executeSql(this._ptr, sql);
  }

  executeTransaction(sql: string): ReturnType<typeof addon.executeTransaction> {
    return addon.executeTransaction(this._ptr, sql);
  }

  executeSqls(sqls: string[]): ReturnType<typeof addon.executeSqls> {
    return addon.executeSqls(this._ptr, sqls);
  }
}
