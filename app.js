/* First-version Safari UI: map flush to the top, bottom sheet only. Real routing, not a mock image. */
(() => {
  const startInput = document.getElementById("start-input");
  const endInput = document.getElementById("end-input");
  const startSub = document.getElementById("start-sub");
  const endSub = document.getElementById("end-sub");
  const distEl = document.getElementById("dist");
  const durEl = document.getElementById("dur");
  const noteEl = document.getElementById("note");
  const filterEl = document.getElementById("filter-line");
  const btn = document.getElementById("btn");
  const hint = document.getElementById("hint");
  const rowStart = document.getElementById("row-start");
  const rowEnd = document.getElementById("row-end");
  const suggestEl = document.getElementById("suggest");

  let scope = null;
  let start = null;
  let end = null;
  let startSel = null;
  let endSel = null;
  let pick = "start";
  let startMarker = null;
  let endMarker = null;
  let map;
  let placesIndex = [];
  let placesReady = false;
  let placesLoadError = null;
  let worker = null;
  let workerReady = false;
  let routeReqId = 0;
  let baselineNote = "";

  const emptyStyle = {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#efeee9" } }],
  };

  function fmtCoord(p) {
    return p[0].toFixed(5) + ", " + p[1].toFixed(5);
  }
  function fmtDist(m) {
    if (m == null) return "—";
    return m < 1000 ? Math.round(m) + " 米" : (m / 1000).toFixed(1) + " 公里";
  }
  function fmtDur(s) {
    if (s == null) return "—";
    const m = Math.round(s / 60);
    return m < 60 ? m + " 分钟" : Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
  }
  function inScope(lng, lat) {
    if (!scope || !scope.scope) return true;
    const b = scope.scope;
    return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
  }
  function descOf(place, p) {
    const bits = [];
    if (place && place.address) bits.push(place.address);
    if (place && place.kind) bits.push(place.kind);
    if (place && (place.kind || "").indexOf("landuse") === 0) bits.push("几何质心，须能吸附到附近道路");
    bits.push(fmtCoord(p));
    return bits.join(" · ");
  }

  async function fetchJsonGz(url) {
    async function decode(buf) {
      const u8 = new Uint8Array(buf);
      const isGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
      if (isGzip) {
        if (typeof DecompressionStream === "undefined") throw new Error("需要支持解压的浏览器（Safari 16.4+）");
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text());
      }
      return JSON.parse(new TextDecoder().decode(buf));
    }
    const r = await fetch(url);
    if (r.ok) return decode(await r.arrayBuffer());
    const plain = url.replace(/\.gz(\?|$)/, "$1");
    if (plain !== url) {
      const r2 = await fetch(plain);
      if (r2.ok) return decode(await r2.arrayBuffer());
    }
    throw new Error(url + " " + r.status);
  }

  function setPick(which) {
    pick = which;
    rowStart.classList.toggle("active", which === "start");
    rowEnd.classList.toggle("active", which === "end");
    hint.style.display = "block";
    hint.textContent = which === "start" ? "点地图或在下方输入起点" : "点地图或在下方输入终点";
  }

  function markerEl(color) {
    const el = document.createElement("div");
    el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px ${color}`;
    return el;
  }

  function setMarker(which, lngLat) {
    if (which === "start") {
      if (startMarker) startMarker.setLngLat(lngLat);
      else startMarker = new maplibregl.Marker({ element: markerEl("#1a9f4b") }).setLngLat(lngLat).addTo(map);
    } else {
      if (endMarker) endMarker.setLngLat(lngLat);
      else endMarker = new maplibregl.Marker({ element: markerEl("#e03c3c") }).setLngLat(lngLat).addTo(map);
    }
  }

  function clearEndpoint(which, msg) {
    if (which === "start") {
      start = null;
      startSel = null;
      startSub.textContent = msg || "未选择。输入后须点选候选，文字本身不是坐标。";
      if (startMarker) {
        startMarker.remove();
        startMarker = null;
      }
    } else {
      end = null;
      endSel = null;
      endSub.textContent = msg || "未选择。输入后须点选候选，文字本身不是坐标。";
      if (endMarker) {
        endMarker.remove();
        endMarker = null;
      }
    }
    btn.disabled = !(start && end && workerReady);
    resetRouteFeedback();
  }

  function applyPoint(which, lng, lat, sel, inputValue) {
    const p = [lng, lat];
    const lngLat = { lng: lng, lat: lat };
    if (which === "start") {
      start = p;
      startSel = sel;
      startInput.value = inputValue;
      startSub.textContent = descOf(sel && sel.place, p);
      setMarker("start", lngLat);
    } else {
      end = p;
      endSel = sel;
      endInput.value = inputValue;
      endSub.textContent = descOf(sel && sel.place, p);
      setMarker("end", lngLat);
    }
    btn.disabled = !(start && end && workerReady);
    if (start && !end) setPick("end");
    resetRouteFeedback();
    hideSuggest();
    if (map && start && end) {
      const b = new maplibregl.LngLatBounds();
      b.extend(start); b.extend(end);
      map.fitBounds(b, { padding: { top: 40, left: 30, right: 30, bottom: 320 }, maxZoom: 15 });
    }
  }

  function placeFromMap(which, lngLat) {
    applyPoint(which, lngLat.lng, lngLat.lat, { source: "map", name: "地图选点" }, "地图选点");
    const sub = (which === "start" ? startSub : endSub);
    if (!inScope(lngLat.lng, lngLat.lat)) {
      sub.textContent = "所选位置在当前路网提取范围外，静态包无法规划。 " + fmtCoord([lngLat.lng, lngLat.lat]);
    }
  }

  function hideSuggest() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
  }

  function routableFlag(place) {
    if (window.PlaceSearch && window.PlaceSearch.isRoutable) return window.PlaceSearch.isRoutable(place);
    if (place.in_extract === false) return false;
    if (place.out_of_scope) return false;
    return true;
  }

  function showSuggestMessage(which, text) {
    suggestEl.hidden = false;
    suggestEl.dataset.which = which;
    suggestEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "suggest-empty";
    empty.textContent = text;
    suggestEl.appendChild(empty);
  }

  function refreshPendingSuggests() {
    const startQ = (startInput.value || "").trim();
    const endQ = (endInput.value || "").trim();
    if (pick === "end" && endQ.length >= 2) renderSuggest("end", endInput.value);
    else if (startQ.length >= 2) renderSuggest("start", startInput.value);
    else if (endQ.length >= 2) renderSuggest("end", endInput.value);
  }

  function renderSuggest(which, query) {
    if (!window.PlaceSearch) {
      hideSuggest();
      return;
    }
    const q = window.PlaceSearch.normalizeQuery ? window.PlaceSearch.normalizeQuery(query) : String(query || "").trim();
    if (!q || q.length < 2) {
      hideSuggest();
      return;
    }
    if (placesLoadError) {
      showSuggestMessage(which, "地点索引加载失败：" + placesLoadError + "。这不是“没有该地点”，请稍后重试或刷新。");
      return;
    }
    if (!placesReady) {
      showSuggestMessage(which, "地点索引仍在加载，完成后会自动列出候选。当前文字还不是坐标，请稍候，不要当成搜不到。");
      return;
    }
    const r = window.PlaceSearch.searchPlaces(placesIndex, query, 12);
    if (r.status === "empty_query" || r.status === "query_too_short") {
      hideSuggest();
      return;
    }
    suggestEl.hidden = false;
    suggestEl.dataset.which = which;
    suggestEl.innerHTML = "";
    if (!r.results.length) {
      const empty = document.createElement("div");
      empty.className = "suggest-empty";
      empty.textContent = r.note || "未找到匹配地点。";
      suggestEl.appendChild(empty);
      return;
    }
    r.results.forEach((place) => {
      const ok = routableFlag(place);
      const item = document.createElement("div");
      item.className = "suggest-item" + (ok ? "" : " out");
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = place.name;
      const d = document.createElement("div");
      d.className = "d";
      const bits = [];
      const kindZh = place.kind_zh || (window.PlaceSearch && window.PlaceSearch.kindLabel && window.PlaceSearch.kindLabel(place.kind, place.name));
      if (kindZh) bits.push(kindZh);
      if (place.address) bits.push(place.address);
      if (place.id) bits.push("OSM " + place.id);
      if (!ok) bits.push(place.scope_note || "超范围，不能规划");
      else bits.push(fmtCoord([place.lng, place.lat]));
      d.textContent = bits.join(" · ");
      item.appendChild(t);
      item.appendChild(d);
      item.addEventListener("mousedown", (ev) => ev.preventDefault());
      item.addEventListener("click", () => chooseCandidate(which, place));
      suggestEl.appendChild(item);
    });
  }

  function chooseCandidate(which, place) {
    const acc = window.PlaceSearch.acceptCandidate(place);
    if (!acc.ok) {
      noteEl.textContent = acc.note || "该地点不能用于本范围规划。";
      return;
    }
    applyPoint(which, acc.lng, acc.lat, { source: "place", name: place.name, place: place }, place.name);
  }

  function onTyped(which) {
    const input = which === "start" ? startInput : endInput;
    const sel = which === "start" ? startSel : endSel;
    const q = input.value;
    setPick(which);
    let keep = null;
    if (sel && sel.source === "place" && window.PlaceSearch) {
      keep = window.PlaceSearch.applySelection(sel.place, q);
    } else if (sel && sel.source === "map") {
      keep = q.trim() === "地图选点" ? sel : null;
    }
    if (!keep) {
      clearEndpoint(which, q.trim() ? "尚未点选候选，文字本身不是坐标。" : undefined);
    }
    renderSuggest(which, q);
  }

  function setRoute(coords) {
    if (!map) return;
    const src = map.getSource("route");
    const data = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords || [] },
    };
    if (src) src.setData(data);
  }

  function resetRouteFeedback() {
    distEl.textContent = "—";
    durEl.textContent = "—";
    setRoute([]);
    if (noteEl && baselineNote) noteEl.textContent = baselineNote;
  }

  function routeViaWorker(slng, slat, elng, elat) {
    return new Promise((resolve, reject) => {
      if (!worker || !workerReady) {
        reject(new Error("路网仍在后台加载"));
        return;
      }
      const id = ++routeReqId;
      const onMsg = (ev) => {
        const m = ev.data || {};
        if (m.id !== id) return;
        worker.removeEventListener("message", onMsg);
        if (m.type === "error") reject(new Error(m.error || "worker error"));
        else resolve(m.route);
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ type: "route", id: id, slng: slng, slat: slat, elng: elng, elat: elat, maxM: 60 });
    });
  }

  async function plan() {
    if (!start || !end) return;
    btn.disabled = true;
    btn.textContent = "规划中…";
    try {
      let data = await routeViaWorker(start[0], start[1], end[0], end[1]);
      if (!data) {
        data = { ok: false, status: "no_router", notes: ["静态包内没有算路数据。"] };
      }
      if (data.ok && data.coordinates && data.coordinates.length >= 2) {
        setRoute(data.coordinates);
        distEl.textContent = fmtDist(data.distance_m);
        durEl.textContent = fmtDur(data.duration_s);
        const extra = (data.notes || []).join(" ");
        noteEl.textContent =
          (scope && scope.disclaimer ? scope.disclaimer + " " : "") +
          (scope && scope.scope ? "当前算路范围：" + scope.scope.name + "。" : "") +
          "地点检索仅含已命名 OSM 要素，不保证所有小区。" +
          extra;
        const b = new maplibregl.LngLatBounds();
        data.coordinates.forEach((c) => b.extend(c));
        map.fitBounds(b, { padding: { top: 40, left: 30, right: 30, bottom: 320 }, maxZoom: 16 });
      } else {
        setRoute([]);
        distEl.textContent = "—";
        durEl.textContent = "—";
        noteEl.textContent = "未能规划：" + (data.status || "unknown") + "。" + ((data.notes || []).join(" "));
      }
    } catch (err) {
      noteEl.textContent = "规划请求失败：" + err;
    } finally {
      btn.disabled = !(start && end && workerReady);
      btn.textContent = "重新规划";
    }
  }

  function startWorker() {
    if (typeof Worker === "undefined") {
      noteEl.textContent = (noteEl.textContent || "") + " 当前浏览器不支持后台算路。";
      return;
    }
    worker = new Worker("router-worker.js");
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "ready") {
        workerReady = true;
        btn.disabled = !(start && end && workerReady);
        const loadNote = "全市路网已在后台加载（约 " + Math.round((m.ms || 0) / 1000) + " 秒，" + (m.segs || "?") + " 段）。";
        baselineNote = (baselineNote || noteEl.textContent || "") + " " + loadNote;
        noteEl.textContent = baselineNote;
      } else if (m.type === "error" && !m.id) {
        noteEl.textContent = "路网加载失败：" + m.error;
      }
    };
    worker.onerror = (err) => {
      noteEl.textContent = "路网后台脚本失败：" + (err && err.message ? err.message : err);
    };
    const url = new URL("data/network.json.gz", window.location.href).href;
    worker.postMessage({ type: "load", url: url });
  }

  async function init() {
    scope = await fetch("data/scope.json").then((r) => r.json());
    const b = scope.scope;
    const view = scope.initial_view || b;
    let extra = " 当前算路范围：" + b.name + "。路网与地点署名：OpenStreetMap 贡献者，ODbL 1.0。地点检索仅含已命名 OSM 要素，不保证所有小区。面状地点使用质心，可能距道路超过 60 米吸附阈值，需在地图上点选附近道路。";
    if (scope.example_places && scope.example_places.start) {
      const s = scope.example_places.start;
      extra += " 可检索公开地名“" + s.name + "”与“" + (scope.example_places.end_query || "龙德广场") + "”；须点选 OSM 中与该名称一致的候选项，不代替选择其他同名点。";
    }
    baselineNote = (scope.disclaimer || "") + extra;
    noteEl.textContent = baselineNote;
    if (filterEl) {
      const filt = scope.camera_filter && scope.camera_filter.label;
      const sel = scope.camera_filter && scope.camera_filter.selection;
      let line = filt || "只开启六环内进京证相关点；六环外与仅早晚高峰已关闭。路网为全市，不按六环裁切。";
      if (sel) {
        line += " 当前硬排除 " + sel.candidate_count + " 个；关闭六环外进京证 " + sel.dropped_six_ring_out_jinjingzheng + " 个；六环字段缺失或异常 " + sel.ring_unknown_jinjingzheng + " 个仅作风险；仅早晚高峰 " + sel.peak_only_count + " 个未启用。";
      }
      const fb = scope.file_bytes || {};
      const segs = scope.match_report_summary && scope.match_report_summary.route_segments_citywide;
      const sizeBits = [];
      if (fb["network.json.gz"]) sizeBits.push("路网压缩包 " + Math.round(fb["network.json.gz"] / 104857.6) / 10 + " MB");
      if (fb["places.json.gz"]) sizeBits.push("地点索引 " + Math.round(fb["places.json.gz"] / 104857.6) / 10 + " MB");
      if (segs) sizeBits.push("可路由路段 " + segs);
      if (sizeBits.length) line += " " + sizeBits.join("，") + "。";
      filterEl.textContent = line;
    }

    map = new maplibregl.Map({
      container: "map",
      style: emptyStyle,
      attributionControl: false,
      bounds: [[view.west, view.south], [view.east, view.north]],
      fitBoundsOptions: { padding: 20 },
      maxBounds: [[b.west - 0.15, b.south - 0.15], [b.east + 0.15, b.north + 0.15]],
      minZoom: 8,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", async () => {
      startWorker();
      try {
      const [roads, excluded, cameras, risks, placesDoc] = await Promise.all([
        fetchJsonGz("data/roads.geojson.gz"),
        fetchJsonGz("data/excluded.geojson.gz").catch(() => fetch("data/excluded.geojson").then((r) => r.json())),
        fetchJsonGz("data/cameras.geojson.gz").catch(() => fetch("data/cameras.geojson").then((r) => r.json())),
        fetchJsonGz("data/risks.geojson.gz").catch(() => fetch("data/risks.geojson").then((r) => r.json())),
        fetchJsonGz("data/places.json.gz"),
      ]);
      placesIndex = (placesDoc && placesDoc.places) || [];
      if (!placesIndex.length) {
        placesLoadError = "地点索引为空";
        placesReady = false;
        refreshPendingSuggests();
        throw new Error(placesLoadError);
      }
      placesReady = true;
      placesLoadError = null;
      refreshPendingSuggests();
      map.addSource("roads", { type: "geojson", data: roads });
      map.addSource("excluded", { type: "geojson", data: excluded });
      map.addSource("cameras", { type: "geojson", data: cameras });
      map.addSource("risks", { type: "geojson", data: risks });
      map.addSource("route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });

      map.addLayer({
        id: "roads", type: "line", source: "roads", minzoom: 8,
        paint: { "line-color": "#d0cdc6", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 1.6, 16, 3] },
      });
      map.addLayer({
        id: "excluded", type: "line", source: "excluded", minzoom: 11,
        paint: { "line-color": "#e29a3a", "line-width": 3.2, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "route", type: "line", source: "route",
        paint: { "line-color": "#1473e6", "line-width": 5, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "cameras", type: "circle", source: "cameras", minzoom: 11,
        paint: { "circle-radius": 4, "circle-color": "#222", "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
      });
      map.addLayer({
        id: "risks", type: "circle", source: "risks", minzoom: 11,
        paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#8a5a00", "circle-stroke-width": 1.5 },
      });
      } catch (err) {
        placesLoadError = String(err && err.message ? err.message : err);
        placesReady = false;
        noteEl.textContent = (noteEl.textContent || "") + " 地图或地点数据加载失败：" + placesLoadError + "。失败不会被显示成“没有该地点”。";
        refreshPendingSuggests();
      }
    });

    map.on("click", (e) => placeFromMap(pick, e.lngLat));
    rowStart.addEventListener("click", () => setPick("start"));
    rowEnd.addEventListener("click", () => setPick("end"));
    startInput.addEventListener("focus", () => setPick("start"));
    endInput.addEventListener("focus", () => setPick("end"));
    startInput.addEventListener("input", () => onTyped("start"));
    endInput.addEventListener("input", () => onTyped("end"));
    startInput.addEventListener("compositionend", () => onTyped("start"));
    endInput.addEventListener("compositionend", () => onTyped("end"));
    startInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") hideSuggest();
    });
    endInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") hideSuggest();
    });
    btn.addEventListener("click", plan);
    document.addEventListener("click", (ev) => {
      if (!suggestEl.contains(ev.target) && ev.target !== startInput && ev.target !== endInput) {
        hideSuggest();
      }
    });
    setPick("start");
  }

  init().catch((err) => {
    noteEl.textContent = "界面加载失败：" + err;
  });
})();
