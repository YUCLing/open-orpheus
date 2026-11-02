import { isNCMUrl } from "@main/util/url";

import type { NetworkInterceptor } from "../types";

const PATH_REGEX = /^\/[a-z]*api\/pc\/upgrade\/get\/?$/;

function isUpgradeRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isNCMUrl(parsed) && PATH_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}

export const updateBlocker: NetworkInterceptor = {
  name: "update-blocker",
  onRequest({ request, respondWith }) {
    if (!isUpgradeRequest(request.url)) return;
    // Mirror a real "no update available" response: callers inspect `status`
    // before parsing the body (see `MusicRecognizer`), so a synthetic response
    // must not look like a transport failure.
    respondWith({
      blob: JSON.stringify({
        code: 200,
        data: {},
        message: "",
      }),
      headers: { "content-type": "application/json" },
      status: 200,
    });
  },
};
