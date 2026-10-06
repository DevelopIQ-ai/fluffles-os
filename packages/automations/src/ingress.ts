import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export type IngressRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  rawBody: Buffer;
};

export type IngressResponse = {
  status: number;
  body: unknown;
};

export type IngressHandler = (request: IngressRequest) => Promise<IngressResponse>;

export type HttpIngressOptions = {
  host: string;
  port: number;
  maxBodyBytes: number;
};

export type Ingress = {
  readonly url: string;
  close(): Promise<void>;
};

/** Constant-time compare of an `sha256=<hex>` signature over the raw body. */
export function verifyHmacSha256(secret: string, rawBody: Buffer, supplied: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, suppliedBuffer);
}

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token"
]);

/**
 * Strips credential-bearing headers. Run history is durable, so a bearer token
 * or a signature must never reach it; a header is kept only as evidence that it
 * was present.
 */
export function redactCredentialHeaders(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const sensitive = CREDENTIAL_HEADERS.has(key) || key.includes("signature") || key.includes("secret");
    safe[key] = sensitive ? "[redacted]" : value;
  }
  return safe;
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * Transport only: it accepts requests and hands them to a handler. Matching,
 * verification, and execution belong to the service, so this listener stays
 * replaceable by any other event source.
 */
export async function startHttpIngress(options: HttpIngressOptions, handler: IngressHandler): Promise<Ingress> {
  const server = http.createServer((request, response) => {
    void (async () => {
      let result: IngressResponse;
      try {
        const rawBody = await readBody(request, options.maxBodyBytes);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[key.toLowerCase()] = value;
        }
        result = await handler({
          method: (request.method ?? "GET").toUpperCase(),
          path: new URL(request.url ?? "/", "http://localhost").pathname,
          headers,
          rawBody
        });
      } catch (error) {
        result = { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      }
      const payload = JSON.stringify(result.body ?? {});
      response.writeHead(result.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      });
      response.end(payload);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}
