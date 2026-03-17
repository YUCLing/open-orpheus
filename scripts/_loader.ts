import { register } from "node:module";
import { pathToFileURL } from "node:url";

const EXTENSION_CANDIDATES = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".json",
] as const;

const NON_PATH_SPECIFIER_PREFIXES = ["node:", "data:"] as const;

function isModuleNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND"
  );
}

function isPathLikeSpecifier(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return true;
  }

  if (specifier.startsWith("/") || specifier.startsWith("file:")) {
    return true;
  }

  for (const prefix of NON_PATH_SPECIFIER_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return false;
    }
  }

  return false;
}

function splitSpecifier(specifier: string): {
  base: string;
  suffix: string;
} {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");

  let splitIndex = -1;

  if (queryIndex >= 0 && hashIndex >= 0) {
    splitIndex = Math.min(queryIndex, hashIndex);
  } else if (queryIndex >= 0) {
    splitIndex = queryIndex;
  } else if (hashIndex >= 0) {
    splitIndex = hashIndex;
  }

  if (splitIndex < 0) {
    return { base: specifier, suffix: "" };
  }

  return {
    base: specifier.slice(0, splitIndex),
    suffix: specifier.slice(splitIndex),
  };
}

function getCandidateSpecifiers(specifier: string): string[] {
  const { base, suffix } = splitSpecifier(specifier);
  const candidates: string[] = [];

  for (const ext of EXTENSION_CANDIDATES) {
    candidates.push(`${base}${ext}${suffix}`);
  }

  for (const ext of EXTENSION_CANDIDATES) {
    candidates.push(`${base}/index${ext}${suffix}`);
  }

  return candidates;
}

type LoaderResolve = (
  specifier: string,
  context: Record<string, unknown>,
  defaultResolve: (
    specifier: string,
    context: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
) => Promise<Record<string, unknown>>;

export const resolve: LoaderResolve = async (
  specifier,
  context,
  defaultResolve
) => {
  try {
    return await defaultResolve(specifier, context);
  } catch (error) {
    if (!isModuleNotFoundError(error) || !isPathLikeSpecifier(specifier)) {
      throw error;
    }

    for (const candidate of getCandidateSpecifiers(specifier)) {
      try {
        return await defaultResolve(candidate, context);
      } catch (candidateError) {
        if (!isModuleNotFoundError(candidateError)) {
          throw candidateError;
        }
      }
    }

    throw error;
  }
};

let didRegister = false;

function getCurrentFileUrl(): string | undefined {
  if (typeof __filename !== "string" || __filename.length === 0) {
    return undefined;
  }

  return pathToFileURL(__filename).href;
}

export function registerExtensionlessLoader(options?: {
  loaderUrl?: string;
  parentUrl?: string;
}): void {
  if (didRegister) {
    return;
  }

  const loaderUrl = options?.loaderUrl ?? getCurrentFileUrl();

  if (!loaderUrl) {
    throw new Error(
      "Cannot infer loader URL in this runtime. Pass options.loaderUrl explicitly."
    );
  }

  register(loaderUrl, options?.parentUrl);
  didRegister = true;
}
