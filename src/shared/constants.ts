import versions from "../../versions.json";
export const BUILD = versions.build;
export const VERSION = versions.version;
export const CORE_VERSION = `${VERSION}.${BUILD}`;
export const NATIVE_VERSION = "60316"; // TODO: Do we need to update this when changing target Web pack version?
export const SECRET_KEY = "7ada0f7ccadbe165e6e7fbe01113f4df";
export const OSVER = "Microsoft-Windows-11--build-22631-64bit";
