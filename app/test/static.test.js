// Gateway static layer (static.js): compression, caching policy, Range, traversal safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStatic, cacheControl } from "../static.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

function serve() {
  const handle = createStatic([["/vendor/tone/", join(APP, "node_modules/tone/build")], ["/", join(APP, "public")]]);
  const srv = http.createServer(async (req, res) => { if (!(await handle(req, res))) res.writeHead(404).end("nope"); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

test("cache policy: versioned samples immutable, code revalidated, media a day", () => {
  assert.match(cacheControl("/voices/lead_v0_C4.flac", "v=Sat%2C%2008"), /immutable/);
  assert.equal(cacheControl("/voices/lead_v0_C4.flac", ""), "no-cache");
  assert.equal(cacheControl("/voices/manifest.json", "v=1"), "no-cache");
  assert.equal(cacheControl("/js/host.js"), "no-cache");
  assert.match(cacheControl("/assets/pfps/frog.webp"), /max-age=86400/);
});

test("text is served pre-compressed with ETag/304; binaries keep Range; no path traversal", async () => {
  const { srv, port } = await serve();
  try {
    const raw = readFileSync(join(APP, "node_modules/tone/build/Tone.js"));
    const br = await get(port, "/vendor/tone/Tone.js", { "accept-encoding": "gzip, deflate, br" });
    assert.equal(br.status, 200);
    assert.equal(br.headers["content-encoding"], "br");
    assert.ok(br.body.length < raw.length / 3, `Tone.js ${raw.length} → ${br.body.length} bytes`);
    assert.ok(zlib.brotliDecompressSync(br.body).equals(raw));
    const gz = await get(port, "/js/host.js", { "accept-encoding": "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.ok(zlib.gunzipSync(gz.body).equals(readFileSync(join(APP, "public/js/host.js"))));
    const plain = await get(port, "/js/host.js");
    assert.equal(plain.headers["content-encoding"], undefined);
    const again = await get(port, "/js/host.js", { "if-none-match": plain.headers.etag });
    assert.equal(again.status, 304);

    const part = await get(port, "/lobby.mp3", { range: "bytes=10-109" });
    assert.equal(part.status, 206);
    assert.equal(part.body.length, 100);
    const flac = await get(port, "/voices_default/harmony_v0_C4.flac?v=1");
    assert.equal(flac.status, 200);

    for (const p of ["/js/../../gateway.js", "/js/%2e%2e/%2e%2e/gateway.js", "/..%2fserver.js", "/js/nope.js"])
      assert.equal((await get(port, p)).status, 404, p);
  } finally { srv.close(); }
});
