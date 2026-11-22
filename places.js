/* Local named-place search. Same rules as src/places.py. No remote geocoding. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlaceSearch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MIN_QUERY_CHARS = 2;
  const DEFAULT_LIMIT = 12;

  function normalizeQuery(s) {
    if (!s) return "";
    return String(s).trim().toLowerCase().replace(/ /g, "").replace(/\u3000/g, "").replace(/\t/g, "");
  }

  function typeRank(kind) {
    if (!kind) return 5;
    const i = kind.indexOf("=");
    const key = i < 0 ? kind : kind.slice(0, i);
    const val = i < 0 ? "" : kind.slice(i + 1);
    if (key === "place" || key === "landuse" || key === "building" || key === "addr:housename") return 0;
    if (key === "highway" && val !== "traffic_signals" && val !== "bus_stop" && val !== "crossing" && val !== "give_way" && val !== "stop") return 1;
    if (key === "amenity" || key === "shop" || key === "leisure" || key === "tourism" || key === "office" || key === "healthcare" || key === "historic" || key === "craft") return 2;
    if (key === "public_transport" || key === "railway") return 3;
    return 4;
  }

  function score(query, name, alts) {
    const hay = normalizeQuery(name);
    if (!hay) return null;
    if (hay === query) return 0;
    if (hay.startsWith(query)) return 1;
    if (hay.indexOf(query) >= 0) return 2;
    const list = alts || [];
    for (let i = 0; i < list.length; i++) {
      const na = normalizeQuery(list[i]);
      if (!na) continue;
      if (na === query) return 3;
      if (na.startsWith(query) || na.indexOf(query) >= 0) return 4;
    }
    return null;
  }

  function searchPlaces(places, query, limit) {
    const q = normalizeQuery(query);
    const lim = limit == null ? DEFAULT_LIMIT : limit;
    if (!q) return { ok: true, status: "empty_query", query: query || "", results: [] };
    if (q.length < MIN_QUERY_CHARS) {
      return {
        ok: true,
        status: "query_too_short",
        query: query,
        results: [],
        note: "请至少输入两个字符。索引仅含已命名的 OSM 地点，不保证所有小区。",
      };
    }
    const scored = [];
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const sc = score(q, p.name || "", p.alts || []);
      if (sc == null) continue;
      scored.push({ sc: sc, out: p.in_bbox ? 0 : 1, tr: typeRank(p.kind), name: p.name || "", id: p.id || "", p: p });
    }
    scored.sort(function (a, b) {
      if (a.sc !== b.sc) return a.sc - b.sc;
      if (a.out !== b.out) return a.out - b.out;
      if (a.tr !== b.tr) return a.tr - b.tr;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    const results = [];
    for (let i = 0; i < scored.length && i < lim; i++) {
      const p = scored[i].p;
      const item = Object.assign({}, p);
      if (!p.in_bbox) {
        item.out_of_scope = true;
        item.scope_note = "该地点在当前验证范围外，不能在本静态包中规划。";
      }
      results.push(item);
    }
    const status = results.length ? "ok" : "no_results";
    const note = results.length
      ? null
      : "未找到匹配的已命名地点。索引来自本图 OSM，不保证所有小区，也未向任何在线地理编码发送查询。";
    return { ok: true, status: status, query: query, results: results, note: note };
  }

  function applySelection(selected, query) {
    if (!selected) return null;
    const q = normalizeQuery(query);
    if (!q) return null;
    const names = [selected.name || ""].concat(selected.alts || []);
    for (let i = 0; i < names.length; i++) {
      if (normalizeQuery(names[i]) === q) return selected;
    }
    if (String(query).trim() === (selected.name || "")) return selected;
    return null;
  }

  function acceptCandidate(place) {
    if (!place) return { ok: false, status: "no_candidate" };
    if (!place.in_bbox) {
      return {
        ok: false,
        status: "out_of_scope",
        place: place,
        note: place.scope_note || "该地点在当前验证范围外，不能在本静态包中规划。",
      };
    }
    if (place.lng == null || place.lat == null) return { ok: false, status: "missing_coords" };
    return { ok: true, status: "selected", place: place, lng: place.lng, lat: place.lat };
  }

  return {
    normalizeQuery: normalizeQuery,
    searchPlaces: searchPlaces,
    applySelection: applySelection,
    acceptCandidate: acceptCandidate,
    MIN_QUERY_CHARS: MIN_QUERY_CHARS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
  };
});
