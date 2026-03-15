import { protocol } from "electron";
import mime from "mime";
import { extname } from "node:path";
import { readFile } from "./ntpk";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "orpheus",
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);

class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

class LoadError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "LoadError";
  }
}

async function loadFromFilePath(
  path: string
): Promise<{ content: Buffer<ArrayBuffer>; contentType: string }> {
  try {
    const fileContent = await readFile(path);
    const contentType =
      mime.getType(extname(path)) || "application/octet-stream";
    return { content: Buffer.from(fileContent), contentType };
  } catch (error) {
    throw new LoadError("Not Found", 404);
  }
}

export async function loadFromOrpheusUrl(
  url: string
): Promise<{ content: Buffer<ArrayBuffer>; contentType: string }> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "orpheus:") {
    throw new NetworkError(`Invalid URL protocol: ${parsedUrl.protocol}`);
  }

  switch (parsedUrl.hostname) {
    case "orpheus":
      return await loadFromFilePath(parsedUrl.pathname);
    case "cache": {
      const url = parsedUrl.search.substring(1); // remove leading '?'
      if (!url) {
        throw new LoadError("Bad Request: Missing URL parameter", 400);
      }
      // TODO: Implement caching logic
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new LoadError(
            `Failed to fetch resource: ${response.statusText}`,
            response.status
          );
        }
        const contentType =
          response.headers.get("Content-Type") || "application/octet-stream";
        const content = Buffer.from(await response.arrayBuffer());
        return { content, contentType };
      } catch (error) {
        throw new LoadError("Failed to fetch resource", 502);
      }
    }
    default:
      throw new NetworkError(`Unknown URL hostname: ${parsedUrl.hostname}`);
  }
}

export default function () {
  protocol.handle("orpheus", async (request) => {
    try {
      const { content, contentType } = await loadFromOrpheusUrl(request.url);
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch (error) {
      if (error instanceof LoadError) {
        return new Response(error.message, { status: error.status });
      } else if (error instanceof NetworkError) {
        return Response.error();
      }
    }
  });
}
