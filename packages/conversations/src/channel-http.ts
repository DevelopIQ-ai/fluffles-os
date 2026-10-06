import type { IncomingMessage, ServerResponse } from "node:http";
import { channelRequestPathname, sendChannelJson } from "./channel";

/**
 * The transport-neutral half of a channel's HTTP ingress: a bounded body
 * reader and a method plus path route table. Channels that cannot use the
 * polling-shaped service (Slack keeps its own status body, its own auth rule
 * and Slack's `url_verification` handshake) still share this plumbing instead
 * of hand-rolling another dispatcher.
 */

export class ChannelRequestBodyLimitError extends Error {}

/** Read only a bounded body so unauthenticated callers cannot exhaust memory. */
export function readChannelRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        rejected = true;
        request.resume();
        reject(new ChannelRequestBodyLimitError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

export type ChannelRouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export interface ChannelRoute {
  method: string;
  path: string;
  handle: ChannelRouteHandler;
}

export interface ChannelRouterOptions {
  routes: readonly ChannelRoute[];
  /** Used for any unmatched method and path pair. Defaults to a 404 JSON body. */
  notFound?: ChannelRouteHandler;
}

export function createChannelRouter(options: ChannelRouterOptions): ChannelRouteHandler {
  const notFound: ChannelRouteHandler = options.notFound
    || ((_request, response) => { sendChannelJson(response, 404, { ok: false, error: "not_found" }); });

  return async (request, response) => {
    const pathname = channelRequestPathname(request);
    for (const route of options.routes) {
      if (route.method === request.method && route.path === pathname) {
        await route.handle(request, response);
        return;
      }
    }
    await notFound(request, response);
  };
}
