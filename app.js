/* First-version Safari UI: map flush to the top, bottom sheet only. Real routing, not a mock image. */
(() => {
  const startInput = document.getElementById("start-input");
  const endInput = document.getElementById("end-input");
  const startSub = document.getElementById("start-sub");
  const endSub = document.getElementById("end-sub");
  const distEl = document.getElementById("dist");
  const durEl = document.getElementById("dur");
  const noteEl = document.getElementById("note");
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
  let bboxNet = null;
  let placesIndex = [];

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
    if (place && place.geom && place.geom !== "node") bits.push("几何质心");
    bits.push(fmtCoord(p));
    return bits.join(" · ");
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
    btn.disabled = !(start && end);
    distEl.textContent = "—";
    durEl.textContent = "—";
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
    btn.disabled = !(start && end);
    if (start && !end) setPick("end");
    distEl.textContent = "—";
    durEl.textContent = "—";
    hideSuggest();
  }

  function placeFromMap(which, lngLat) {
    applyPoint(which, lngLat.lng, lngLat.lat, { source: "map", name: "地图选点" }, "地图选点");
    const sub = (which === "start" ? startSub : endSub);
    if (!inScope(lngLat.lng, lngLat.lat)) {
      sub.textContent = "所选位置在验证范围外，静态包可能无法规划。 " + fmtCoord([lngLat.lng, lngLat.lat]);
    }
  }

  function hideSuggest() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
  }

  function renderSuggest(which, query) {
    if (!window.PlaceSearch) {
      hideSuggest();
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
      const item = document.createElement("div");
      item.className = "suggest-item" + (place.out_of_scope || !place.in_bbox ? " out" : "");
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = place.name;
      const d = document.createElement("div");
      d.className = "d";
      const bits = [];
      if (place.address) bits.push(place.address);
      if (place.kind) bits.push(place.kind);
      if (place.out_of_scope || !place.in_bbox) bits.push(place.scope_note || "超范围，不能规划");
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
      noteEl.textContent = acc.note || "该地点不能用于本验证范围规划。";
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
    const src = map.getSource("route");
    const data = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords || [] },
    };
    if (src) src.setData(data);
  }

  async function plan() {
    if (!start || !end) return;
    btn.disabled = true;
    btn.textContent = "规划中…";
    try {
      let data = null;
      if (bboxNet && window.BBoxRouter) {
        data = window.BBoxRouter.route(bboxNet, start[0], start[1], end[0], end[1], 60);
      }
      const allowApi = !!(scope && scope.allow_api_fallback === true);
      if (allowApi && (!data || !data.ok)) {
        const r = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start, end }),
        });
        const api = await r.json();
        if (api && api.ok) {
          api.notes = (api.notes || []).concat(["此条由本地全程路网服务计算，可能走出当前地图验证范围。"]);
          data = api;
        } else if (!data) {
          data = api;
        }
      }
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
          (scope && scope.scope ? "当前地图范围：" + scope.scope.name + "。" : "") +
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
      btn.disabled = !(start && end);
      btn.textContent = "重新规划";
    }
  }

  async function init() {
    scope = await fetch("data/scope.json").then((r) => r.json());
    const b = scope.scope;
    let extra = " 当前地图范围：" + b.name + "。路网与地点署名：OpenStreetMap 贡献者，ODbL 1.0。地点检索仅含已命名 OSM 要素，不保证所有小区。";
    if (scope.suggested_test_points && scope.suggested_test_points.start) {
      const s = scope.suggested_test_points.start, e = scope.suggested_test_points.end;
      extra += " 静态验证示例可点选附近道路：" + s.lng.toFixed(5) + "," + s.lat.toFixed(5) + " → " + e.lng.toFixed(5) + "," + e.lat.toFixed(5) + "。";
    }
    noteEl.textContent = (scope.disclaimer || "") + extra;

    map = new maplibregl.Map({
      container: "map",
      style: emptyStyle,
      attributionControl: false,
      bounds: [[b.west, b.south], [b.east, b.north]],
      fitBoundsOptions: { padding: 20 },
      minZoom: 10,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", async () => {
      const [roads, excluded, cameras, risks, net, placesDoc] = await Promise.all([
        fetch("data/roads.geojson").then((r) => r.json()),
        fetch("data/excluded.geojson").then((r) => r.json()),
        fetch("data/cameras.geojson").then((r) => r.json()),
        fetch("data/risks.geojson").then((r) => r.json()),
        fetch("data/network.json").then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch("data/places.json").then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      bboxNet = net;
      placesIndex = (placesDoc && placesDoc.places) || [];
      map.addSource("roads", { type: "geojson", data: roads });
      map.addSource("excluded", { type: "geojson", data: excluded });
      map.addSource("cameras", { type: "geojson", data: cameras });
      map.addSource("risks", { type: "geojson", data: risks });
      map.addSource("route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });

      map.addLayer({ id: "roads", type: "line", source: "roads",
        paint: { "line-color": "#d0cdc6", "line-width": 2.2 } });
      map.addLayer({ id: "excluded", type: "line", source: "excluded",
        paint: { "line-color": "#e29a3a", "line-width": 3.2, "line-opacity": 0.95 } });
      map.addLayer({ id: "route", type: "line", source: "route",
        paint: { "line-color": "#1473e6", "line-width": 5, "line-opacity": 0.95 } });
      map.addLayer({ id: "cameras", type: "circle", source: "cameras",
        paint: { "circle-radius": 4, "circle-color": "#222", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
      map.addLayer({ id: "risks", type: "circle", source: "risks",
        paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#8a5a00", "circle-stroke-width": 1.5 } });
    });

    map.on("click", (e) => placeFromMap(pick, e.lngLat));
    rowStart.addEventListener("click", () => setPick("start"));
    rowEnd.addEventListener("click", () => setPick("end"));
    startInput.addEventListener("focus", () => setPick("start"));
    endInput.addEventListener("focus", () => setPick("end"));
    startInput.addEventListener("input", () => onTyped("start"));
    endInput.addEventListener("input", () => onTyped("end"));
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
