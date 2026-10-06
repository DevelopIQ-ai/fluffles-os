import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import {
  ChannelRequestBodyLimitError,
  createChannelRouter,
  readChannelRequestBuffer
} from "../src/channel-http";

test("the router dispatches on method and path and falls back to a 404 body", async () => {
  const seen: string[] = [];
  const handler = createChannelRouter({
    routes: [
      { method: "GET", path: "/healthz", handle: (_req, res) => { seen.push("health"); res.end("ok"); } },
      { method: "POST", path: "/hook", handle: async (_req, res) => { seen.push("hook"); res.end("hooked"); } }
    ]
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    assert.equal(await (await fetch(`${url}/healthz`)).text(), "ok");
    assert.equal(await (await fetch(`${url}/hook`, { method: "POST" })).text(), "hooked");
    // A query string must not defeat matching, and the method is part of the key.
    assert.equal(await (await fetch(`${url}/healthz?verbose=1`)).text(), "ok");
    const wrongMethod = await fetch(`${url}/healthz`, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual(await wrongMethod.json(), { ok: false, error: "not_found" });
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    assert.deepEqual(seen, ["health", "hook", "health"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a custom notFound handler replaces the default 404 body", async () => {
  const handler = createChannelRouter({
    routes: [],
    notFound: (_req, res) => { res.writeHead(418); res.end("teapot"); }
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${url}/anything`);
    assert.equal(response.status, 418);
    assert.equal(await response.text(), "teapot");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the bounded reader returns the body under the limit and rejects over it", async () => {
  const small = new PassThrough();
  const read = readChannelRequestBuffer(small as unknown as IncomingMessage, 16);
  small.end("hello");
  assert.equal((await read).toString("utf8"), "hello");

  const big = new PassThrough();
  const rejected = readChannelRequestBuffer(big as unknown as IncomingMessage, 4);
  big.end("0123456789");
  await assert.rejects(rejected, ChannelRequestBodyLimitError);
});
