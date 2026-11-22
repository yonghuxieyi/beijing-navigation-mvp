/* Static citywide router — same rules as src/route.py (snap, via-way triples,
   walked-interval collision, unconfirmed-risk disclosure). Supports the legacy
   object network (v1) and the packed citywide network (v=2). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BBoxRouter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function hav(lng1, lat1, lng2, lat2) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function project(lng, lat, coords) {
    let best = null;
    const lat0 = coords[0][1];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    let acc = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const ax = 0, ay = 0, bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky;
      const px = (lng - a[0]) * kx, py = (lat - a[1]) * ky;
      const denom = bx * bx + by * by;
      let t = denom === 0 ? 0 : (px * bx + py * by) / denom;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = ax + t * bx, qy = ay + t * by;
      const dist = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2);
      const slen = Math.sqrt(bx * bx + by * by);
      if (!best || dist < best.dist_m) {
        best = {
          dist_m: dist,
          offset_m: acc + t * slen,
          lng: a[0] + t * (b[0] - a[0]),
          lat: a[1] + t * (b[1] - a[1]),
        };
      }
      acc += slen;
    }
    return best;
  }
  function sliceLine(coords, startM, endM) {
    if (endM < startM) { const t = startM; startM = endM; endM = t; }
    const out = [];
    const lat0 = coords[0][1];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    let acc = 0;
    function at(a, b, t) { return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; }
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const slen = Math.sqrt(((b[0] - a[0]) * kx) ** 2 + ((b[1] - a[1]) * ky) ** 2);
      const aM = acc, bM = acc + slen;
      if (bM < startM - 1e-6) { acc = bM; continue; }
      if (aM > endM + 1e-6) break;
      if (aM >= startM - 1e-6 && aM <= endM + 1e-6) out.push(a);
      if (startM > aM && startM < bM) out.push(at(a, b, slen ? (startM - aM) / slen : 0));
      if (endM > aM && endM < bM) out.push(at(a, b, slen ? (endM - aM) / slen : 0));
      if (bM >= startM - 1e-6 && bM <= endM + 1e-6) out.push(b);
      acc = bM;
    }
    return out.length >= 2 ? out : (coords.slice ? coords.slice(0, 2) : coords);
  }

  function isV2(net) { return !!(net && net.v === 2); }

  function decodeLines(net) {
    if (net._lines) return net._lines;
    const xy = net.xy, off = net.line_off, lines = new Array(off.length - 1);
    for (let lid = 0; lid < off.length - 1; lid++) {
      const pts = [];
      let x = 0, y = 0;
      for (let i = off[lid]; i < off[lid + 1]; i += 2) {
        x += xy[i]; y += xy[i + 1];
        pts.push([x / 1e6, y / 1e6]);
      }
      lines[lid] = pts;
    }
    net._lines = lines;
    return lines;
  }

  function edgeCoords(net, eid) {
    if (!isV2(net)) {
      const e = net.edges[String(eid)];
      return e ? e.coords : null;
    }
    const lines = decodeLines(net);
    const pts = lines[net.e_line[eid]];
    if (!pts) return null;
    if (net.e_rev[eid]) {
      const rev = net._linesRev || (net._linesRev = {});
      const lid = net.e_line[eid];
      if (!rev[lid]) rev[lid] = pts.slice().reverse();
      return rev[lid];
    }
    return pts;
  }
  function edgeEx(net, eid) {
    if (!isV2(net)) {
      const e = net.edges[String(eid)];
      return (e && e.ex) || [];
    }
    const a = net.e_ex_off[eid], b = net.e_ex_off[eid + 1], out = [];
    for (let i = a; i < b; i += 2) out.push([net.e_ex[i] / 100, net.e_ex[i + 1] / 100]);
    return out;
  }
  function edgeWay(net, eid) {
    if (!isV2(net)) {
      const e = net.edges[String(eid)];
      return e ? e.way : null;
    }
    return net.e_way[eid];
  }
  function edgeKmh(net, eid) {
    if (!isV2(net)) {
      const e = net.edges[String(eid)] || {};
      return e.kmh || 30;
    }
    return net.e_kmh[eid] || 30;
  }
  function edgeLen(net, eid) {
    if (!isV2(net)) {
      const e = net.edges[String(eid)];
      if (!e) return 0;
      if (e.len != null) return e.len;
      const c = e.coords;
      let s = 0;
      for (let i = 0; i < c.length - 1; i++) s += hav(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
      return s;
    }
    return net.e_len[eid] / 100;
  }
  function getSeg(net, sid) {
    if (!isV2(net) || net.segs) {
      return net.segs[String(sid)];
    }
    const start = net.s_start[sid] / 100, end = net.s_end[sid] / 100;
    return { id: sid, edge: net.s_edge[sid], start: start, end: end, len: end - start };
  }
  function getAdj(net, sid) {
    if (isV2(net) && net.adj_off) {
      return net.adj.slice(net.adj_off[sid], net.adj_off[sid + 1]);
    }
    return net.adj[String(sid)] || [];
  }
  function buildGrid(net) {
    if (net._grid) return net._grid;
    const grid = new Map();
    if (isV2(net) && net.grid && net.grid.length) {
      const g = net.grid;
      let i = 0;
      while (i < g.length) {
        const cx = g[i], cy = g[i + 1], n = g[i + 2];
        i += 3;
        const ids = g.slice(i, i + n);
        i += n;
        grid.set(cx + "," + cy, ids);
      }
    }
    net._grid = grid;
    return grid;
  }
  function candidateEdges(net, lng, lat, radiusM) {
    if (isV2(net) && net.grid) {
      const cs = net.grid_deg || 0.01;
      const grid = buildGrid(net);
      const pad = Math.max(1, Math.ceil((radiusM + 50) / (cs * 85000)));
      const i0 = Math.floor(lng / cs), j0 = Math.floor(lat / cs);
      const seen = new Set(), ids = [];
      for (let i = i0 - pad; i <= i0 + pad; i++) {
        for (let j = j0 - pad; j <= j0 + pad; j++) {
          const cell = grid.get(i + "," + j);
          if (!cell) continue;
          for (let k = 0; k < cell.length; k++) {
            const eid = cell[k];
            if (!seen.has(eid)) { seen.add(eid); ids.push(eid); }
          }
        }
      }
      return ids;
    }
    const edges = net.edges || {};
    return Object.keys(edges).map((x) => +x);
  }
  function segsOnEdge(net, eid) {
    if (!net._segsByEdge) {
      const m = new Map();
      if (isV2(net) && net.s_edge) {
        for (let sid = 1; sid < net.s_edge.length; sid++) {
          const e = net.s_edge[sid];
          if (!e) continue;
          let arr = m.get(e);
          if (!arr) { arr = []; m.set(e, arr); }
          arr.push(getSeg(net, sid));
        }
      } else {
        for (const id of Object.keys(net.segs || {})) {
          const s = net.segs[id];
          const k = s.edge;
          let arr = m.get(k);
          if (!arr) { arr = []; m.set(k, arr); }
          arr.push(s);
        }
      }
      net._segsByEdge = m;
    }
    return net._segsByEdge.get(eid) || [];
  }

  function prepare(net) {
    if (!net || net._prepared) return net;
    if (isV2(net)) {
      decodeLines(net);
      buildGrid(net);
      segsOnEdge(net, 1);
    }
    net._prepared = true;
    return net;
  }

  function segCoords(net, seg) {
    if (seg.coords) return seg.coords;
    const coords = edgeCoords(net, seg.edge);
    return sliceLine(coords, seg.start, seg.end);
  }
  function onExcluded(net, eid, offset, slop) {
    slop = slop == null ? 0.2 : slop;
    const ivs = edgeEx(net, eid);
    for (let i = 0; i < ivs.length; i++) {
      const iv = ivs[i];
      const a = iv[0], b = iv[1];
      if (offset >= a - slop && offset <= b + slop) return iv;
    }
    return null;
  }
  function MiniHeap() { this.a = []; }
  MiniHeap.prototype.push = function (x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  MiniHeap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (!a.length) return top;
    a[0] = last;
    let i = 0;
    for (;;) {
      let l = i * 2 + 1, r = l + 1, s = i;
      if (l < a.length && a[l][0] < a[s][0]) s = l;
      if (r < a.length && a[r][0] < a[s][0]) s = r;
      if (s === i) break;
      const t = a[i]; a[i] = a[s]; a[s] = t; i = s;
    }
    return top;
  };
  function tripleBlocked(net, prevSid, sid, nxt) {
    const triples = net.triples || [];
    if (!triples.length || prevSid == null) return false;
    const pe = getSeg(net, prevSid).edge;
    const ce = getSeg(net, sid).edge;
    const ne = getSeg(net, nxt).edge;
    for (let i = 0; i < triples.length; i++) {
      const t = triples[i];
      if (t[0] === pe && t[1] === ce && t[2] === ne) return true;
    }
    return false;
  }
  function nearestBeyond(net, lng, lat, probeM) {
    const ids = candidateEdges(net, lng, lat, probeM);
    let best = null;
    for (let i = 0; i < ids.length; i++) {
      const eid = ids[i];
      const coords = edgeCoords(net, eid);
      if (!coords || coords.length < 2) continue;
      const proj = project(lng, lat, coords);
      if (!proj) continue;
      if (proj.dist_m > probeM) continue;
      if (!best || proj.dist_m < best.dist_m) {
        best = { dist_m: proj.dist_m, edge_id: eid, way_id: edgeWay(net, eid), lng: proj.lng, lat: proj.lat, offset_m: proj.offset_m };
      }
    }
    return best;
  }
  function collectScored(net, lng, lat, radiusM) {
    const ids = candidateEdges(net, lng, lat, radiusM + 80);
    const scored = [];
    for (let i = 0; i < ids.length; i++) {
      const eid = ids[i];
      const coords = edgeCoords(net, eid);
      if (!coords || coords.length < 2) continue;
      const c0 = coords[0], c1 = coords[coords.length - 1];
      if (Math.abs(c0[0] - lng) * 85000 > radiusM + 400 && Math.abs(c1[0] - lng) * 85000 > radiusM + 400 &&
          Math.abs(c0[1] - lat) * 111000 > radiusM + 400 && Math.abs(c1[1] - lat) * 111000 > radiusM + 400) continue;
      const proj = project(lng, lat, coords);
      if (!proj || proj.dist_m > radiusM) continue;
      scored.push({ dist_m: proj.dist_m, edge_id: eid, proj: proj, way_id: edgeWay(net, eid) });
    }
    return scored;
  }
  function snap(net, lng, lat, maxM) {
    prepare(net);
    maxM = maxM || 60;
    const extendM = 250;
    let scored = collectScored(net, lng, lat, maxM);
    let extended = false;
    if (!scored.length) {
      scored = collectScored(net, lng, lat, extendM);
      extended = scored.length > 0;
    }
    if (!scored.length) {
      const near = nearestBeyond(net, lng, lat, 250);
      const rec = { status: "unsnapped", dist_m: near ? near.dist_m : null, alternates: [] };
      if (near) {
        rec.nearest_edge_id = near.edge_id;
        rec.nearest_way_id = near.way_id;
      }
      return rec;
    }
    scored.sort((a, b) => a.dist_m - b.dist_m);
    const bestDist = scored[0].dist_m;
    const nearestWay = scored[0].way_id;
    const same = scored.filter((s) => s.way_id === nearestWay && s.dist_m <= bestDist + 1.5);
    const free = [], excluded = [];
    for (let i = 0; i < same.length; i++) {
      const s = same[i];
      const iv = onExcluded(net, s.edge_id, s.proj.offset_m);
      if (iv) {
        excluded.push({
          status: "in_exclusion", edge_id: s.edge_id, way_id: s.way_id,
          dist_m: s.dist_m, offset_m: s.proj.offset_m, lng: s.proj.lng, lat: s.proj.lat,
          interval: iv,
        });
        continue;
      }
      const list = segsOnEdge(net, s.edge_id);
      let hit = null;
      for (let j = 0; j < list.length; j++) {
        const seg = list[j];
        if (seg.start - 0.6 <= s.proj.offset_m && s.proj.offset_m <= seg.end + 0.6) { hit = seg; break; }
      }
      if (!hit) {
        excluded.push({ status: "unsnapped", edge_id: s.edge_id, dist_m: s.dist_m });
        continue;
      }
      free.push({
        status: "snapped", edge_id: s.edge_id, way_id: s.way_id, dist_m: s.dist_m,
        seg_id: hit.id, offset_m: Math.max(0, Math.min(hit.len, s.proj.offset_m - hit.start)),
        offset_on_edge_m: s.proj.offset_m, lng: s.proj.lng, lat: s.proj.lat,
        snap_extended: extended, preferred_max_m: maxM,
      });
    }
    if (!free.length) {
      const bestEx = excluded[0] || { status: "unsnapped", dist_m: bestDist, alternates: [] };
      if (bestEx.status !== "in_exclusion") bestEx.status = excluded.length ? "in_exclusion" : "unsnapped";
      bestEx.alternates = [];
      return bestEx;
    }
    free.sort((a, b) => a.dist_m - b.dist_m);
    const best = Object.assign({}, free[0]);
    best.alternates = free.slice(0, 4);
    return best;
  }
  function astar(net, startSid, startOff, endSid, endOff) {
    const ss = getSeg(net, startSid), es = getSeg(net, endSid);
    if (!ss || !es) return null;
    const startCoords = segCoords(net, ss);
    if (startSid === endSid && endOff + 0.5 >= startOff) {
      return {
        seg_ids: [startSid], length_m: Math.max(0, endOff - startOff),
        coords: sliceLine(startCoords, startOff, endOff),
        walked: [[ss.edge, ss.start + startOff, ss.start + endOff]],
      };
    }
    const startRem = Math.max(0, ss.len - startOff);
    const goal = (function () {
      const c = segCoords(net, es); return c[c.length - 1];
    })();
    const heap = new MiniHeap();
    const startKey = startSid + ":0";
    heap.push([startRem, startRem, startSid, 0]);
    const prev = new Map([[startKey, null]]);
    const gscore = new Map([[startKey, startRem]]);
    let endKey = null;
    while (heap.a.length) {
      const item = heap.pop();
      const g = item[1], sid = item[2], psid = item[3];
      const state = sid + ":" + psid;
      if (g > (gscore.get(state) || 1e18) + 1e-6) continue;
      if (sid === endSid && state !== startKey) { endKey = state; break; }
      const nxts = getAdj(net, sid);
      for (let i = 0; i < nxts.length; i++) {
        const nxt = nxts[i];
        if (tripleBlocked(net, psid === 0 ? null : psid, sid, nxt)) continue;
        const ns = getSeg(net, nxt);
        if (!ns) continue;
        const ng = g + (nxt === endSid ? endOff : ns.len);
        const nstate = nxt + ":" + sid;
        if (ng + 0.05 < (gscore.get(nstate) || 1e18)) {
          gscore.set(nstate, ng);
          prev.set(nstate, state);
          if (nxt === endSid) heap.push([ng, ng, nxt, sid]);
          else {
            const c = segCoords(net, ns);
            const endc = c[c.length - 1];
            heap.push([ng + hav(endc[0], endc[1], goal[0], goal[1]), ng, nxt, sid]);
          }
        }
      }
    }
    if (!endKey) {
      let bestG = null;
      for (const [st, gv] of gscore) {
        if (st.split(":")[0] === String(endSid) && st !== startKey) {
          if (bestG == null || gv < bestG) { bestG = gv; endKey = st; }
        }
      }
    }
    if (!endKey) return null;
    const chain = [];
    let cur = endKey;
    while (cur) {
      chain.push(+cur.split(":")[0]);
      const p = prev.get(cur);
      if (p == null) break;
      cur = p;
    }
    chain.reverse();
    if (chain[0] !== startSid) return null;
    const coords = [];
    let length = 0;
    const walked = [];
    for (let i = 0; i < chain.length; i++) {
      const s = getSeg(net, chain[i]);
      const a = i === 0 ? startOff : 0;
      const b = i === chain.length - 1 ? endOff : s.len;
      const piece = sliceLine(segCoords(net, s), a, b);
      length += Math.max(0, b - a);
      walked.push([s.edge, Math.min(s.start + a, s.start + b), Math.max(s.start + a, s.start + b)]);
      if (coords.length && piece.length && coords[coords.length - 1][0] === piece[0][0] && coords[coords.length - 1][1] === piece[0][1]) {
        for (let j = 1; j < piece.length; j++) coords.push(piece[j]);
      } else {
        for (let j = 0; j < piece.length; j++) coords.push(piece[j]);
      }
    }
    return { seg_ids: chain, length_m: length, coords: coords, walked: walked };
  }
  function duration(net, segIds, startOff, endOff) {
    let t = 0;
    for (let i = 0; i < segIds.length; i++) {
      const s = getSeg(net, segIds[i]);
      const kmh = edgeKmh(net, s.edge) || 30;
      const slen = i === 0 && i === segIds.length - 1 ? Math.max(0, endOff - startOff)
        : i === 0 ? Math.max(0, s.len - startOff)
        : i === segIds.length - 1 ? endOff
        : s.len;
      t += (Math.max(0, slen) / 1000.0) / kmh * 3600.0;
    }
    return t;
  }
  function overlap(a0, a1, b0, b1) { return Math.max(a0, b0) < Math.min(a1, b1) - 0.2; }
  function collision(net, walked) {
    const hits = [];
    for (let i = 0; i < (walked || []).length; i++) {
      const eid = walked[i][0], a0 = walked[i][1], a1 = walked[i][2];
      const ivs = edgeEx(net, eid);
      for (let j = 0; j < ivs.length; j++) {
        const iv = ivs[j];
        if (overlap(a0, a1, iv[0], iv[1])) hits.push({ edge_id: eid, walked: [a0, a1], interval: iv });
      }
    }
    return { ok: hits.length === 0, hits: hits };
  }
  function nearbyUnconfirmed(coords, risks, radii) {
    radii = radii || [40, 80, 150];
    const cams = risks || [];
    if (!coords || !coords.length || !cams.length) {
      const counts = {};
      for (let i = 0; i < radii.length; i++) counts["le_" + radii[i] + "m"] = 0;
      return { counts: counts, nearby: [] };
    }
    const nearby = [];
    const counts = {};
    for (let i = 0; i < radii.length; i++) counts["le_" + radii[i] + "m"] = 0;
    for (let c = 0; c < cams.length; c++) {
      const cam = cams[c];
      let dmin = 1e18;
      for (let i = 0; i < coords.length; i++) dmin = Math.min(dmin, hav(cam.lng, cam.lat, coords[i][0], coords[i][1]));
      const rec = { id: cam.id, status: cam.status, dist_m: dmin };
      nearby.push(rec);
      for (let i = 0; i < radii.length; i++) if (dmin <= radii[i]) counts["le_" + radii[i] + "m"] += 1;
    }
    return { counts: counts, nearby: nearby.filter((x) => x.dist_m <= 150) };
  }
  function unsnappedNote(which, snap, maxM) {
    let msg = (which === "start" ? "起点" : "终点") + "未吸附到可通行路段（远离路网，或无法落到未排除的碎片上）。";
    if (snap && snap.dist_m != null) {
      msg += " 距最近机动车道约 " + Math.round(snap.dist_m) + " 米，超过 " + Math.round(maxM) + " 米吸附阈值。请在地图上点选该地点附近的道路；未把地点质心改写成路口。";
    }
    return msg;
  }
  function extendedSnapNote(which, snap, maxM) {
    if (!snap || snap.status !== "snapped") return null;
    const dist = snap.dist_m;
    if (!snap.snap_extended && !(dist != null && dist > maxM + 0.5)) return null;
    const label = which === "start" ? "起点" : "终点";
    return label + "已吸附到距所选点约 " + Math.round(dist) + " 米的最近机动车道，这不是地点入口或官方出入口，也未改写地点坐标。";
  }
  function route(net, slng, slat, elng, elat, maxM) {
    prepare(net);
    maxM = maxM || 60;
    const ssnap = snap(net, slng, slat, maxM);
    const esnap = snap(net, elng, elat, maxM);
    if (ssnap.status === "in_exclusion") {
      return { ok: false, status: "start_in_exclusion", start_snap: ssnap, end_snap: esnap,
        notes: ["起点落在已排除的沿路 100 米区间内，未改放到附近可通行路上。请另选起点。"] };
    }
    if (esnap.status === "in_exclusion") {
      return { ok: false, status: "end_in_exclusion", start_snap: ssnap, end_snap: esnap,
        notes: ["终点落在已排除的沿路 100 米区间内，未改放到附近可通行路上。请另选终点。"] };
    }
    if (ssnap.status !== "snapped") {
      return { ok: false, status: "start_unsnapped", start_snap: ssnap, end_snap: esnap,
        notes: [unsnappedNote("start", ssnap, maxM)] };
    }
    if (esnap.status !== "snapped") {
      return { ok: false, status: "end_unsnapped", start_snap: ssnap, end_snap: esnap,
        notes: [unsnappedNote("end", esnap, maxM)] };
    }
    const starts = ssnap.alternates || [ssnap];
    const ends = esnap.alternates || [esnap];
    const pairs = [];
    for (const a of starts) for (const b of ends) pairs.push([a, b]);
    pairs.sort((p, q) => p[0].dist_m + p[1].dist_m - (q[0].dist_m + q[1].dist_m));
    let best = null, usedS = ssnap, usedE = esnap;
    for (const pr of pairs) {
      const cand = astar(net, pr[0].seg_id, pr[0].offset_m, pr[1].seg_id, pr[1].offset_m);
      if (cand) { best = cand; usedS = pr[0]; usedE = pr[1]; break; }
    }
    if (!best) {
      return { ok: false, status: "no_path", start_snap: usedS, end_snap: usedE,
        notes: ["在当前全市路网提取范围的排除约束和转向限制下未找到路径。"] };
    }
    const col = collision(net, best.walked);
    const risks = nearbyUnconfirmed(best.coords, net.risks);
    const n150 = (risks.counts && risks.counts.le_150m) || 0;
    const dur = duration(net, best.seg_ids, (usedS.offset_m || 0), (usedE.offset_m != null ? usedE.offset_m : 0));
    const notes = [];
    const es = extendedSnapNote("start", usedS, maxM); if (es) notes.push(es);
    const ee = extendedSnapNote("end", usedE, maxM); if (ee) notes.push(ee);
    if (!col.ok) {
      notes.push("独立碰撞校验未通过：走过的有向边与排除区间重叠。不把该路线当作成功避让。");
      return { ok: false, status: "collision", distance_m: best.length_m, duration_s: dur,
        coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
        notes: notes };
    }
    if (n150) {
      notes.push("已按已吸附点的沿路 100 米约束规划，并通过独立碰撞校验。附近 " + n150 + " 个歧义或未匹配点未进入硬排除，不能当作已避开。这不是免罚保证。");
      return { ok: true, status: "ok_with_unconfirmed_risk", distance_m: best.length_m, duration_s: dur,
        coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
        notes: notes };
    }
    notes.push("已按已吸附点的沿路 100 米约束规划，并通过独立碰撞校验。附近 150 米内未发现歧义或未匹配点；这仍不是免罚保证。");
    return { ok: true, status: "ok", distance_m: best.length_m, duration_s: dur,
      coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
      notes: notes };
  }
  return { route, snap, collision, nearbyUnconfirmed, project, hav, sliceLine, prepare, nearestBeyond };
});
