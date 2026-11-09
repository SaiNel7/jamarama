// Static assets for the public demo, served ONCE by the gateway instead of being proxied into
// every room process: the pages, scripts, CSS, images, lobby track and instrument samples are
// identical in every room (rooms run NO_PREBAKE, so /voices/ is the shared stock kit).
//
//   text (js/css/html/json/svg/map) → pre-compressed once (brotli + gzip, off the event loop),
//                                     kept in memory, ETag + 304s
//   everything else                 → serve-static (Range for <audio>, ETag, streaming)
//
// Caching: versioned sample URLs (/voices/…?v=<rev>) are immutable; images/audio/fonts a day;
// code/markup "no-cache" (always revalidated → 304 when unchanged, so a redeploy is picked up at once).
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import serveStatic from "serve-static";

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const TEXT = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const DAY = 86400;

export function cacheControl(urlPath, query = "") {
  if (urlPath.startsWith("/voices/")) {
    if (urlPath.endsWith("manifest.json")) return "no-cache";
    return /(^|&)v=/.test(query) ? "public, max-age=31536000, immutable" : "no-cache";
  }
  const ext = extname(urlPath).toLowerCase();
  if (TEXT[ext]) return "no-cache";
  return `public, max-age=${DAY}`;
}

/**
 * @param {Array<[string, string]>} mounts  [urlPrefix, dir] — first match wins
 * @returns {(req, res) => Promise<boolean>}  true if it handled the request
 */
export function createStatic(mounts) {
  const cache = new Map();                    // file → { mtimeMs, size, etag, raw, br, gz }
  const statics = mounts.map(([prefix, dir]) => [prefix, dir,
    serveStatic(dir, { index: false, fallthrough: true, cacheControl: false, etag: true, lastModified: true })]);

  async function compressed(file) {
    const st = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const raw = await readFile(file);
    const [br, gz] = await Promise.all([
      brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
      gzip(raw, { level: 9 }),
    ]);
    const entry = { mtimeMs: st.mtimeMs, size: st.size, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, raw, br, gz };
    cache.set(file, entry);
    return entry;
  }

  function resolve(urlPath) {
    for (const [prefix, dir, serve] of statics) {
      if (!urlPath.startsWith(prefix)) continue;
      const rel = decodeURIComponent(urlPath.slice(prefix.length));
      const file = normalize(join(dir, rel));
      if (!file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;      // path traversal
      return { file, prefix, serve };
    }
    return null;
  }

  return async function handle(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const [urlPath, query = ""] = req.url.split("?");
    let hit;
    try { hit = resolve(urlPath); } catch { return false; }
    if (!hit) return false;
    const ext = extname(hit.file).toLowerCase();
    res.setHeader("Cache-Control", cacheControl(urlPath, query));
    if (TEXT[ext]) {
      let e;
      try { e = await compressed(hit.file); } catch { return false; }        // missing → let the caller 404/proxy
      res.setHeader("ETag", e.etag);
      res.setHeader("Last-Modified", new Date(e.mtimeMs).toUTCString());
      res.setHeader("Vary", "Accept-Encoding");
      if (req.headers["if-none-match"] === e.etag) { res.writeHead(304).end(); return true; }
      const ae = String(req.headers["accept-encoding"] || "");
      const [body, enc] = /\bbr\b/.test(ae) ? [e.br, "br"] : /\bgzip\b/.test(ae) ? [e.gz, "gzip"] : [e.raw, null];
      res.writeHead(200, { "Content-Type": TEXT[ext], "Content-Length": body.length, ...(enc ? { "Content-Encoding": enc } : {}) });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    }
    // binary: strip the mount prefix and hand over to serve-static (Range, ETag, streaming)
    return new Promise((done) => {
      const orig = req.url;
      req.url = req.url.slice(hit.prefix.length - 1) || "/";
      hit.serve(req, res, () => { req.url = orig; res.removeHeader("Cache-Control"); done(false); });
      res.on("finish", () => done(true));
      res.on("close", () => done(true));
    });
  };
}
