import path from "node:path";

import { Protocol } from "electron";
import mime from "mime";

import { getPluginManager } from "@main/plugin";
import { resolvePluginAssetTarget } from "@main/plugin/assets";
import { toError } from "@shared/util";

function notFound(): Response {
  return new Response(null, { status: 404 });
}

async function servePluginAsset(url: URL): Promise<Response> {
  let pluginId: string;
  let assetPath: string;
  try {
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    pluginId = segments.shift() ?? "";
    assetPath = segments.join("/");
  } catch {
    return notFound();
  }

  if (!pluginId || !assetPath) return notFound();

  const plugin = getPluginManager()?.getPlugin(pluginId);
  if (!plugin) return notFound();

  try {
    // Keep the request under `<plugin tree>/assets`; the tree itself also
    // rejects paths escaping the plugin root.
    const target = await resolvePluginAssetTarget(plugin.source, assetPath);
    if (target === null) {
      LOGGER.warn({ pluginId, assetPath }, "Blocked a plugin asset path escape");
      return notFound();
    }

    const content = await plugin.tree.readFile(path.join("assets", assetPath));
    return new Response(new Uint8Array(content), {
      headers: {
        "Content-Type": mime.getType(assetPath) ?? "application/octet-stream",
      },
    });
  } catch (error) {
    LOGGER.debug({ pluginId, assetPath, err: toError(error) }, "Failed to read a plugin asset");
    return notFound();
  }
}

export default function registerAssetsScheme(protocol: Protocol) {
  protocol.handle("assets", async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "plugins") {
      return servePluginAsset(url);
    }
    return notFound();
  });
}
