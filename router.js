/* Static bbox router — same rules as src/route.py (snap, via-way triples,
   walked-interval collision, unconfirmed-risk counts). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BBoxRouter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function hav(lng1, lat1, lng2, lat2) {
    const R = 6371000, toR = Math.PI / 180;
    const dlat = (lat2 - lat1) * toR, dlng = (lng2 - lng1) * toR;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dlng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function project(lng, lat, coords) {
    let best = null, prefix = 0;
    const lat0 = coords[0][1];
    const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const bx = (b[0] - a[0]) * mx, by = (b[1] - a[1]) * my;
      const px = (lng - a[0]) * mx, py = (lat - a[1]) * my;
      const ab2 = bx * bx + by * by;
      let t = ab2 <= 1e-12 ? 0 : (px * bx + py * by) / ab2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = t * bx, qy = t * by;
      const dist = Math.hypot(px - qx, py - qy);
      const seglen = hav(a[0], a[1], b[0], b[1]);
      if (!best || dist < best.dist_m) {
        best = {
          lng: a[0] + (mx ? qx / mx : 0),
          lat: a[1] + qy / my,
          dist_m: dist,
          offset_m: prefix + t * seglen,
          t,
        };
      }
      prefix += seglen;
    }
    if (best) best.length_m = prefix;
    return best;
  }
  function sliceLine(coords, startM, endM) {
    if (endM < startM) { const x = startM; startM = endM; endM = x; }
    const out = [];
    let acc = 0;
    const at = (a, b, sl, d) => {
      if (sl <= 1e-9) return a;
      const t = Math.max(0, Math.min(1, d / sl));
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const sl = hav(a[0], a[1], b[0], b[1]);
      const segEnd = acc + sl;
      if (segEnd < startM - 1e-6) { acc = segEnd; continue; }
      if (acc > endM + 1e-6) break;
      if (acc <= startM && startM <= segEnd) out.push(at(a, b, sl, startM - acc));
      else if (acc >= startM && acc <= endM && (!out.length || out[out.length - 1][0] !== a[0] || out[out.length - 1][1] !== a[1])) out.push(a);
      if (acc <= endM && endM <= segEnd) {
        const p = at(a, b, sl, endM - acc);
        if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
        break;
      }
      acc = segEnd;
    }
    return out.length >= 2 ? out : (coords.slice ? coords.slice(0, 2) : coords);
  }
  function segCoords(net, seg) {
    if (seg.coords) return seg.coords;
    const e = net.edges[String(seg.edge)];
    if (!e) return [];
    return sliceLine(e.coords, seg.start, seg.end);
  }
  function onExcluded(net, eid, offset, slop) {
    const e = net.edges[String(eid)];
    const ivs = (e && e.ex) || [];
    slop = slop == null ? 0.5 : slop;
    for (let i = 0; i < ivs.length; i++) {
      const a = ivs[i][0], b = ivs[i][1];
      if (a - slop <= offset && offset <= b + slop) return ivs[i];
    }
    return null;
  }
  function MiniHeap() { this.a = []; }
  MiniHeap.prototype.push = function (x) {
    const a = this.a; a.push(x);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  MiniHeap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        let l = i * 2 + 1, r = l + 1, s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        const t = a[i]; a[i] = a[s]; a[s] = t; i = s;
      }
    }
    return top;
  };
  function tripleBlocked(net, prevSid, sid, nxt) {
    const triples = net.triples || [];
    if (!triples.length || prevSid == null) return false;
    const pe = net.segs[String(prevSid)].edge;
    const ce = net.segs[String(sid)].edge;
    const ne = net.segs[String(nxt)].edge;
    for (let i = 0; i < triples.length; i++) {
      const t = triples[i];
      if (t[0] === pe && t[1] === ce && t[2] === ne) return true;
    }
    return false;
  }
  function snap(net, lng, lat, maxM) {
    maxM = maxM || 60;
    let scored = [];
    const edges = net.edges || {};
    for (const id of Object.keys(edges)) {
      const e = edges[id];
      const c0 = e.coords[0], c1 = e.coords[e.coords.length - 1];
      if (Math.abs(c0[0] - lng) * 85000 > maxM + 400 && Math.abs(c1[0] - lng) * 85000 > maxM + 400) continue;
      const proj = project(lng, lat, e.coords);
      if (!proj || proj.dist_m > maxM) continue;
      scored.push({ dist_m: proj.dist_m, edge_id: +id, proj: proj, way_id: e.way });
    }
    if (!scored.length) return { status: "unsnapped", dist_m: null, alternates: [] };
    scored.sort((a, b) => a.dist_m - b.dist_m);
    const bestDist = scored[0].dist_m;
    const nearestWay = scored[0].way_id;
    const same = scored.filter((s) => s.way_id === nearestWay && s.dist_m <= bestDist + 1.5);
    const free = [], excluded = [];
    const segsByEdge = net.segsByEdge || (function () {
      const m = {};
      for (const id of Object.keys(net.segs)) {
        const s = net.segs[id];
        const k = String(s.edge);
        (m[k] || (m[k] = [])).push(s);
      }
      net.segsByEdge = m;
      return m;
    })();
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
      const list = segsByEdge[String(s.edge_id)] || [];
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
    const segs = net.segs;
    const ss = segs[String(startSid)], es = segs[String(endSid)];
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
      const nxts = net.adj[String(sid)] || [];
      for (let i = 0; i < nxts.length; i++) {
        const nxt = nxts[i];
        if (tripleBlocked(net, psid === 0 ? null : psid, sid, nxt)) continue;
        const ns = segs[String(nxt)];
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
      const s = segs[String(chain[i])];
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
      const s = net.segs[String(segIds[i])];
      const e = (net.edges && net.edges[String(s.edge)]) || {};
      const kmh = Math.max(8, e.kmh || s.kmh || 30);
      let slen = s.len;
      if (segIds.length === 1) slen = endOff - startOff;
      else if (i === 0) slen = s.len - startOff;
      else if (i === segIds.length - 1) slen = endOff;
      t += (Math.max(0, slen) / 1000) / kmh * 3600;
    }
    return t;
  }
  function overlap(a0, a1, b0, b1) { return Math.max(a0, b0) < Math.min(a1, b1) - 0.2; }
  function collision(net, walked) {
    const hits = [];
    if (!walked) return { ok: true, hits: [], note: "no walked intervals" };
    for (let i = 0; i < walked.length; i++) {
      const eid = walked[i][0], a = walked[i][1], b = walked[i][2];
      const e = net.edges[String(eid)] || {};
      const ivs = e.ex || [];
      for (let j = 0; j < ivs.length; j++) {
        if (overlap(a, b, ivs[j][0], ivs[j][1])) {
          hits.push({ edge_id: eid, interval: ivs[j], walked: [a, b], reason: "walked_interval_overlaps_exclusion" });
        }
      }
      if (i > 0 && walked[i - 1][0] === eid) {
        const gap0 = Math.min(walked[i - 1][2], a), gap1 = Math.max(walked[i - 1][2], a);
        if (gap1 - gap0 > 0.5) {
          for (let j = 0; j < ivs.length; j++) {
            if (overlap(gap0, gap1, ivs[j][0], ivs[j][1])) {
              hits.push({ edge_id: eid, interval: ivs[j], reason: "same_edge_gap_skips_exclusion" });
            }
          }
        }
      }
    }
    return {
      ok: hits.length === 0,
      hits: hits,
      note: "独立校验按走过的有向边区间与排除区间是否重叠，不以平面 3.5 米阈值判定主辅路。不是罚款预测。",
    };
  }
  function nearbyUnconfirmed(coords, risks, radii) {
    radii = radii || [40, 80, 150];
    const counts = {}, ids = {};
    for (const r of radii) { counts["le_" + r + "m"] = 0; ids["le_" + r + "m"] = []; }
    const cams = risks || [];
    if (!coords || !coords.length || !cams.length) {
      return { radii_m: radii, counts: counts, ids: ids,
        note: "这些点未进入硬排除，不能当作已避开。距离是到路线折线的球面距离，不是沿路 100 米约束。" };
    }
    for (const cam of cams) {
      let dmin = Infinity;
      for (let i = 0; i < coords.length; i++) dmin = Math.min(dmin, hav(cam.lng, cam.lat, coords[i][0], coords[i][1]));
      for (const r of radii) {
        if (dmin <= r) {
          counts["le_" + r + "m"]++;
          ids["le_" + r + "m"].push(cam.id);
        }
      }
    }
    return { radii_m: radii, counts: counts, ids: ids,
      note: "这些点未进入硬排除，不能当作已避开。距离是到路线折线的球面距离，不是沿路 100 米约束。" };
  }
  function route(net, slng, slat, elng, elat, maxM) {
    const ssnap = snap(net, slng, slat, maxM || 60);
    const esnap = snap(net, elng, elat, maxM || 60);
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
        notes: ["起点未吸附到可通行路段（远离路网，或无法落到未排除的碎片上）。"] };
    }
    if (esnap.status !== "snapped") {
      return { ok: false, status: "end_unsnapped", start_snap: ssnap, end_snap: esnap,
        notes: ["终点未吸附到可通行路段（远离路网，或无法落到未排除的碎片上）。"] };
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
        notes: ["在本验证范围的排除约束和转向限制下未找到路径（路线若需绕出该范围，静态图无法给出）"] };
    }
    const col = collision(net, best.walked);
    const risks = nearbyUnconfirmed(best.coords, net.risks);
    const n150 = (risks.counts && risks.counts.le_150m) || 0;
    const dur = duration(net, best.seg_ids, (usedS.offset_m || 0), (usedE.offset_m != null ? usedE.offset_m : 0));
    if (!col.ok) {
      return { ok: false, status: "collision", distance_m: best.length_m, duration_s: dur,
        coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
        notes: ["独立碰撞校验未通过：走过的有向边与排除区间重叠。不把该路线当作成功避让。"] };
    }
    if (n150) {
      return { ok: true, status: "ok_with_unconfirmed_risk", distance_m: best.length_m, duration_s: dur,
        coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
        notes: ["已按已吸附点的沿路 100 米约束规划，并通过独立碰撞校验。附近 " + n150 + " 个歧义或未匹配点未进入硬排除，不能当作已避开。这不是免罚保证。"] };
    }
    return { ok: true, status: "ok", distance_m: best.length_m, duration_s: dur,
      coordinates: best.coords, start_snap: usedS, end_snap: usedE, collision: col, risks: risks,
      notes: ["已按已吸附点的沿路 100 米约束规划，并通过独立碰撞校验。附近 150 米内未发现歧义或未匹配点；这仍不是免罚保证。"] };
  }
  return { route, snap, collision, nearbyUnconfirmed, project, hav, sliceLine };
});
