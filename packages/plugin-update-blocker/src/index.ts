import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api";

const PATH_REGEX = /^\/[a-z]*api\/pc\/upgrade\/get\/?$/;

function isUpgradeRequest(url: string, isNCMUrl: (url: string | URL) => boolean): boolean {
  try {
    const parsed = new URL(url);
    return isNCMUrl(parsed) && PATH_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}

let dispose: (() => void) | null = null;

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { isNCMUrl } = await runtime.registry.load("@main/util/url");
  const { networkInterceptorPipeline } = await runtime.registry.load("@main/network/interceptor");

  networkInterceptorPipeline.use({
    name: "update-blocker",
    onRequest({ request, respondWith }) {
      if (!isUpgradeRequest(request.url, isNCMUrl)) return;
      // Mirror a real "no update available" response: callers inspect `status`
      // before parsing the body, so a synthetic response must not look like a
      // transport failure.
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
  });

  dispose = () => networkInterceptorPipeline.unuse("update-blocker");
};

export const deactivate: PluginModule["deactivate"] = () => {
  dispose?.();
  dispose = null;
};
