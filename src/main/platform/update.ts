import { app } from "electron";
import semver from "semver";

import type { UpdateInfo } from "$sharedTypes/update";

let cachedUpdateInfo: UpdateInfo | null | false = false;

export async function checkUpdate(
  ignoreCache = false
): Promise<UpdateInfo | null> {
  if (!ignoreCache && cachedUpdateInfo !== false) return cachedUpdateInfo;

  const res: {
    tag_name: string;
    html_url: string;
    published_at: string;
    body: string;
  } = await fetch(
    "https://api.github.com/repos/YUCLing/open-orpheus/releases/latest"
  ).then((res) => res.json());

  const current = semver.coerce(app.getVersion());
  const latest = semver.coerce(res.tag_name);

  if (!current || !latest) {
    throw new Error("Invalid version syntaxes.");
  }

  if (!semver.gt(latest, current)) return (cachedUpdateInfo = null);

  return (cachedUpdateInfo = {
    version: res.tag_name,
    releaseNote: res.body,
    url: res.html_url,
    time: res.published_at,
  });
}
