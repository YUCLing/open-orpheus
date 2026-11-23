/**
 * Matches the napi-rs CLI as a command word, including a path to it
 * (`./node_modules/.bin/napi`) and the Windows shims, but not other
 * `napi-`-prefixed words such as `napi-derive`.
 */
const NAPI_COMMAND = /(?:^|[\\/])napi(?:\.cmd|\.exe)?$/;

/**
 * Detects whether a build script actually shells out to the napi-rs CLI.
 *
 * `napi build --use-napi-cross` unpacks the shared cross toolchain into
 * `~/.napi-rs/cross-toolchain/<version>/<triple>` before it starts compiling.
 * Every module in a layer shares that cache, so two of them running at the same
 * time extract into the same directory and one of them dies with
 * "failed to unpack ...". Those builds are therefore run one at a time.
 */
export function invokesNapi(script: string): boolean {
  return script.split(/&&|\|\||[;|]/).some((segment) =>
    segment
      .trim()
      .split(/\s+/)
      .some((token) => NAPI_COMMAND.test(token))
  );
}
