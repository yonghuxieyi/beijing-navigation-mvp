/* Background router so the phone UI thread is not frozen during load or A*. */
/* global BBoxRouter */
importScripts("router.js");

let net = null;

async function decodeMaybeGzip(buf) {
  const u8 = new Uint8Array(buf);
  const isGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  if (isGzip) {
    if (typeof DecompressionStream === "undefined") throw new Error("需要支持解压的浏览器（Safari 16.4+）");
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}
async function loadGzipJson(url) {
  const r = await fetch(url);
  if (r.ok) return decodeMaybeGzip(await r.arrayBuffer());
  const plain = url.replace(/\.gz(\?|$)/, "$1");
  if (plain !== url) {
    const r2 = await fetch(plain);
    if (r2.ok) return decodeMaybeGzip(await r2.arrayBuffer());
  }
  throw new Error("load " + url + " failed: " + r.status);
}

self.onmessage = async function (ev) {
  const m = ev.data || {};
  try {
    if (m.type === "load") {
      const t0 = Date.now();
      net = await loadGzipJson(m.url);
      BBoxRouter.prepare(net);
      self.postMessage({
        type: "ready",
        ms: Date.now() - t0,
        segs: net.seg_count || (net.segs && Object.keys(net.segs).length) || 0,
        edges: net.edge_count || (net.edges && Object.keys(net.edges).length) || 0,
      });
    } else if (m.type === "route") {
      if (!net) throw new Error("network not loaded");
      const t0 = Date.now();
      const route = BBoxRouter.route(net, m.slng, m.slat, m.elng, m.elat, m.maxM || 60);
      self.postMessage({ type: "result", id: m.id, route: route, ms: Date.now() - t0 });
    } else if (m.type === "snap") {
      if (!net) throw new Error("network not loaded");
      const snap = BBoxRouter.snap(net, m.lng, m.lat, m.maxM || 60);
      self.postMessage({ type: "snap", id: m.id, snap: snap });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: String(err && err.message ? err.message : err) });
  }
};
