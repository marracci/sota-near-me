/* SOTA Alerts Near Me — app logic. Loaded by index.html; loads Leaflet from vendor/leaflet/ on first map use. */
(() => {
  "use strict";

  // ---------- Config ----------
  const ALERT_URLS = [
    "https://api-db2.sota.org.uk/api/alerts/365/all/all",
    "https://api2.sota.org.uk/api/alerts/365/all/all",
    "https://api2.sota.org.uk/api/alerts"
  ];
  const ASSOC_URL = "https://api2.sota.org.uk/api/associations";
  // Summit refs come from the API, so they are validated (isValidRef) and each path segment is encoded.
  const refPath = ref => ref.split("/").map(encodeURIComponent).join("/");
  const SUMMIT_URLS = [
    ref => `https://api2.sota.org.uk/api/summits/${refPath(ref)}`,
    ref => `https://api.sotl.as/summits/${refPath(ref)}`
  ];
  const sotlasUrl = ref => `https://sotl.as/summits/${refPath(ref)}`;
  const REF_RE = /^[A-Z0-9]{1,5}\/[A-Z0-9]{1,3}-\d{1,4}$/;
  const isValidRef = ref => REF_RE.test(ref);
  const CONCURRENCY = 5;
  const NO_FILTER_CAP = 400;   // max summits to look up if association bounds are unavailable
  const PAST_GRACE_H = 3;      // still show alerts that started up to N hours ago
  const CACHE_KEY = "sotaSummitCoords.v1";
  const PREFS_KEY = "sotaAlertsNear.prefs.v1";

  // ---------- Helpers ----------
  const $ = id => document.getElementById(id);
  const statusEl = $("status");
  let abortCtl = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = kind || "";
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Safe DOM builder: text goes through textContent; links are forced to https and open with noopener/noreferrer.
  function el(tag, opts = {}, children = []) {
    const n = document.createElement(tag);
    if (opts.cls) n.className = opts.cls;
    if (opts.text !== undefined) n.textContent = String(opts.text);
    if (opts.href) {
      const u = new URL(opts.href);
      if (u.protocol === "https:") n.href = u.href;
      if (opts.newTab) { n.target = "_blank"; n.rel = "noopener noreferrer"; }
    }
    for (const c of children) n.appendChild(c);
    return n;
  }
  function pick(o, ...keys) {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
    return undefined;
  }

  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
  }
  function cleanCoords(c) {
    if (!c || typeof c !== "object") return null;
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
    const num = v => (v === "" || v === null || v === undefined || !isFinite(Number(v))) ? "" : Number(v);
    return { lat, lon, name: String(c.name ?? "").slice(0, 120), altM: num(c.altM), points: num(c.points) };
  }
  const coordCache = (() => {
    const raw = loadJSON(CACHE_KEY, {}), out = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) { const c = cleanCoords(v); if (isValidRef(k) && c) out[k] = c; }
    }
    return out;
  })();

  async function getJSON(url, signal) {
    const r = await fetch(url, {
      signal, headers: { "Accept": "application/json" },
      credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", cache: "no-store"
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return r.json();
  }
  async function firstWorking(urls, signal) {
    const errs = [];
    for (const u of urls) {
      try { return { data: await getJSON(u, signal), url: u }; }
      catch (e) { if (e.name === "AbortError") throw e; errs.push(`${u} → ${e.message}`); }
    }
    const err = new Error("All endpoints failed:\n" + errs.join("\n"));
    err.isNet = true;
    throw err;
  }

  // Maidenhead -> lat/lon (center of square)
  function gridToLatLon(g) {
    g = g.trim();
    // At least a 4-character square (about 70 x 100 miles); a 2-character field is far wider than 250 miles.
    if (!/^[A-Ra-r]{2}\d{2}([A-Xa-x]{2}(\d{2}([A-Xa-x]{2})?)?)?$/.test(g)) return null;
    g = g.toUpperCase();
    let lon = -180, lat = -90;
    let lonSize = 20, latSize = 10;
    lon += (g.charCodeAt(0) - 65) * lonSize;
    lat += (g.charCodeAt(1) - 65) * latSize;
    let i = 2, level = 1;
    while (i < g.length) {
      if (level % 2 === 1) { // digits: 10 divisions
        lonSize /= 10; latSize /= 10;
        lon += Number(g[i]) * lonSize; lat += Number(g[i + 1]) * latSize;
      } else {               // letters: 24 divisions
        lonSize /= 24; latSize /= 24;
        lon += (g.charCodeAt(i) - 65) * lonSize; lat += (g.charCodeAt(i + 1) - 65) * latSize;
      }
      i += 2; level++;
    }
    return { lat: lat + latSize / 2, lon: lon + lonSize / 2,
             box: { minLat: lat, maxLat: lat + latSize, minLon: lon, maxLon: lon + lonSize } };
  }
  function latLonToGrid(lat, lon) {
    let x = lon + 180, y = lat + 90;
    const A = 65;
    let s = String.fromCharCode(A + Math.floor(x / 20)) + String.fromCharCode(A + Math.floor(y / 10));
    x %= 20; y %= 10;
    s += Math.floor(x / 2) + "" + Math.floor(y / 1);
    x %= 2; y %= 1;
    s += String.fromCharCode(97 + Math.floor(x * 12)) + String.fromCharCode(97 + Math.floor(y * 24));
    return s;
  }

  const R_KM = 6371.0088;
  const toRad = d => d * Math.PI / 180;
  function distanceKm(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.sqrt(h));
  }
  function bearingDeg(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const compass = d => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(d / 22.5) % 16];

  function bboxOverlapsCircle(box, c, rKm) {
    const dLat = rKm / 111.2;
    const dLon = rKm / (111.2 * Math.max(Math.cos(toRad(c.lat)), 0.01));
    return !(c.lat + dLat < box.minLat || c.lat - dLat > box.maxLat ||
             c.lon + dLon < box.minLon || c.lon - dLon > box.maxLon);
  }

  function isWildcard(code) { return /X{2,}|\?/i.test(code); }

  function normAlert(a) {
    const assoc = String(pick(a, "associationCode", "AssociationCode") || "").toUpperCase();
    const code = String(pick(a, "summitCode", "SummitCode") || "").toUpperCase();
    const when = new Date(pick(a, "dateActivated", "DateActivated"));
    return {
      id: pick(a, "id", "Id"),
      call: pick(a, "activatingCallsign", "ActivatingCallsign") || "",
      name: pick(a, "activatorName", "ActivatorName") || "",
      assoc, code, ref: `${assoc}/${code}`,
      details: pick(a, "summitDetails", "SummitDetails") || "",
      freq: pick(a, "frequency", "Frequency") || "",
      comments: pick(a, "comments", "Comments") || "",
      poster: pick(a, "posterCallsign", "PosterCallsign") || "",
      when
    };
  }

  function extractCoords(s) {
    if (!s) return null;
    let lat = pick(s, "latitude", "Latitude", "lat");
    let lon = pick(s, "longitude", "Longitude", "lon", "lng");
    if ((lat === undefined || lon === undefined) && s.coordinates) {
      lat = pick(s.coordinates, "latitude", "lat");
      lon = pick(s.coordinates, "longitude", "lon", "lng");
    }
    if (lat === undefined || lon === undefined) { lat = pick(s, "gridRef2"); lon = pick(s, "gridRef1"); }
    return cleanCoords({
      lat, lon,
      name: pick(s, "name", "Name", "summitName") || "",
      altM: pick(s, "altM", "AltM", "altitude") ?? "",
      points: pick(s, "points", "Points") ?? ""
    });
  }

  async function summitCoords(ref, signal) {
    if (!isValidRef(ref)) return null;           // never put an unvalidated ref into a URL
    if (coordCache[ref]) return coordCache[ref];
    for (const mk of SUMMIT_URLS) {
      try {
        const c = extractCoords(await getJSON(mk(ref), signal));
        if (c) { coordCache[ref] = c; return c; }
      } catch (e) { if (e.name === "AbortError") throw e; }
    }
    return null;
  }

  async function pool(items, n, fn, onProgress) {
    let i = 0, done = 0;
    const out = new Array(items.length);
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        done++; onProgress && onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // ---------- Band / mode parsing ----------
  // [name, lowMHz, highMHz] - low edges are floored so shorthand like "14" or "7" or "146" matches
  const BANDS = [
    ["160m", 1.8, 1.999], ["80m", 3.5, 4.0], ["60m", 5.0, 5.45], ["40m", 7.0, 7.3], ["30m", 10.0, 10.15],
    ["20m", 14.0, 14.35], ["17m", 18.0, 18.168], ["15m", 21.0, 21.45], ["12m", 24.0, 24.99], ["10m", 28.0, 29.7],
    ["6m", 50.0, 54.0], ["2m", 144.0, 148.0], ["1.25m", 219.0, 225.0], ["70cm", 420.0, 450.0], ["23cm", 1240, 1300]
  ];
  const BAND_NAMES = BANDS.map(b => b[0]);
  const HF = ["160m","80m","60m","40m","30m","20m","17m","15m","12m","10m"];
  // Bands that reliably work within ~250 miles. This app is for local/regional chasing,
  // so alerts posted ONLY on other bands (30m and up) are left out of the results.
  //  - VHF/UHF: line of sight, extended by summit height
  //  - HF 160/80/60/40m: ground wave and near-vertical skywave (NVIS), roughly 0-250 mi
  //    (40m is most dependable in daytime, when most activations happen; at night it skips farther)
  const LOCAL_VU = ["6m", "2m", "1.25m", "70cm", "23cm"];
  const LOCAL_HF = ["160m", "80m", "60m", "40m"];
  const LOCAL_BANDS = new Set([...LOCAL_VU, ...LOCAL_HF]);
  const MODES = ["CW", "SSB", "FM", "AM", "Data", "DV"];
  const MODE_WORDS = {
    cw: "CW", ssb: "SSB", usb: "SSB", lsb: "SSB", phone: "SSB", fm: "FM", am: "AM",
    ft8: "Data", ft4: "Data", data: "Data", digi: "Data", digital: "Data", psk: "Data", psk31: "Data",
    js8: "Data", js8call: "Data", rtty: "Data", olivia: "Data", vara: "Data",
    dv: "DV", dmr: "DV", dstar: "DV", "d-star": "DV", c4fm: "DV", fusion: "DV", ysf: "DV", m17: "DV"
  };
  const freqCache = new Map();
  function parseFreq(str) {
    if (freqCache.has(str)) return freqCache.get(str);
    const bands = new Set(), modes = new Set();
    let s = String(str || "").toLowerCase();
    // explicit band names: "40m", "2 m", "70cm", "1.25m"
    s = s.replace(/(\d+(?:\.\d+)?)\s?(cm|m)\b/g, (_, n, u) => {
      const name = `${Number(n)}${u}`;
      if (BAND_NAMES.includes(name)) bands.add(name);
      return " ";
    });
    // broad words
    if (/\bhf\b/.test(s)) HF.forEach(b => bands.add(b));
    if (/\bvhf\b/.test(s)) { bands.add("6m"); bands.add("2m"); }
    if (/\buhf\b/.test(s)) bands.add("70cm");
    // mode words (also catches "14.062-cw", "7.2ssb")
    for (const w of s.split(/[^a-z0-9-]+|(?<=\d)(?=[a-z])|-(?=[a-z])/)) {
      const m = MODE_WORDS[w.replace(/^-/, "")];
      if (m) modes.add(m);
    }
    if (/d-star/.test(s)) modes.add("DV");
    // frequencies in MHz (kHz values like 14062 are converted)
    for (const tok of s.match(/\d+(?:\.\d+)?/g) || []) {
      if (tok === "10") { bands.add("10m"); continue; }   // bare "10" almost always means 10 m; 30 m users write 10.1xx
      let f = parseFloat(tok);
      if (f >= 1800 && f < 30000) f /= 1000;          // kHz written out
      const b = BANDS.find(([, lo, hi]) => f >= lo && f <= hi);
      if (b) bands.add(b[0]);
      else if (/^\d+$/.test(tok) && BAND_NAMES.includes(tok + "m")) bands.add(tok + "m"); // "40-cw" = 40 metres
    }
    // infer FM for plain 2m/70cm alerts with no mode is tempting but unreliable, so leave unknown
    const out = { bands, modes };
    freqCache.set(str, out);
    return out;
  }

  function buildToggles(id, names, cls) {
    const el = $(id);
    for (const n of names) {
      const lab = document.createElement("label");
      lab.className = "tog";
      lab.innerHTML = `<input type="checkbox" class="${cls}" value="${esc(n)}"><span>${esc(n)}</span>`;
      el.appendChild(lab);
    }
  }
  buildToggles("bandTogglesV", LOCAL_VU, "bandCb");
  buildToggles("bandTogglesH", LOCAL_HF, "bandCb");
  buildToggles("modeToggles", MODES, "modeCb");

  function bmState() {
    return {
      bands: [...document.querySelectorAll(".bandCb:checked")].map(c => c.value),
      modes: [...document.querySelectorAll(".modeCb:checked")].map(c => c.value),
      unclear: $("incUnclear").checked
    };
  }
  function passesBM(r, st) {
    const p = parseFreq(r.freq);
    if (st.bands.length) {
      if (p.bands.size) { if (!st.bands.some(b => p.bands.has(b))) return false; }
      else if (!st.unclear) return false;
    }
    if (st.modes.length) {
      if (p.modes.size) { if (!st.modes.some(m => p.modes.has(m))) return false; }
      else if (!st.unclear) return false;
    }
    return true;
  }
  // True if the alert lists at least one regional band, or no recognisable band at all
  // (unclear alerts are kept so nothing is silently missed).
  function isRegional(r) {
    const p = parseFreq(r.freq);
    return p.bands.size === 0 || [...p.bands].some(b => LOCAL_BANDS.has(b));
  }
  function longHaulNote(n) {
    return n ? ` ${n} alert(s) in this area were posted only for long-distance HF bands (30m and up) and aren't shown.` : "";
  }
  function tagsHTML(freq) {
    const p = parseFreq(freq);
    let bl = [...p.bands].sort((a, b) => BAND_NAMES.indexOf(a) - BAND_NAMES.indexOf(b));
    if (HF.every(x => p.bands.has(x))) bl = ["HF (any)"].concat(bl.filter(x => !HF.includes(x)));
    const t = bl.concat([...p.modes]);
    if (!t.length) return `<div class="tags"><span class="tag q">unclear</span></div>`;
    return `<div class="tags">${t.map(x => `<span class="tag">${esc(x)}</span>`).join("")}</div>`;
  }

  // ---------- Rendering ----------
  let rows = [];
  let sortKey = "time", sortDir = 1;

  const fmtUTC = d => d.toISOString().slice(0, 16).replace("T", " ") + "Z";
  const fmtLocal = d => d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function render(units) {
    const tb = $("tbody");
    const st = bmState();
    const filtering = st.bands.length || st.modes.length;
    const visible = rows.filter(r => passesBM(r, st));
    const note = $("filterNote");
    note.hidden = !filtering || !rows.length && !lastWild.length;
    if (filtering) {
      const wv = lastWild.filter(r => passesBM(r, st)).length;
      note.textContent = `Band/mode filter (${[...st.bands, ...st.modes].join(", ")}): showing ${visible.length} of ${rows.length} alerts` +
        (lastWild.length ? `, ${wv} of ${lastWild.length} unplaced` : "") + ".";
    }
    const sorted = visible.slice().sort((a, b) => {
      let va, vb;
      switch (sortKey) {
        case "dist": va = a.distKm ?? Infinity; vb = b.distKm ?? Infinity; break;
        case "call": va = a.call; vb = b.call; break;
        case "ref": va = a.ref; vb = b.ref; break;
        default: va = a.when.getTime(); vb = b.when.getTime();
      }
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
    document.querySelectorAll("th[data-sort]").forEach(th => {
      th.classList.toggle("sorted-asc", th.dataset.sort === sortKey && sortDir === 1);
      th.classList.toggle("sorted-desc", th.dataset.sort === sortKey && sortDir === -1);
    });
    if (!sorted.length) {
      tb.innerHTML = `<tr><td colspan="6" class="empty">${rows.length ? "No alerts match the band/mode filter." : "No matching alerts during this window."}</td></tr>`;
      return;
    }
    units = units === "km" ? "km" : "mi";
    const k = units === "mi" ? 0.621371 : 1;
    tb.innerHTML = sorted.map(r => {
      const hasDist = typeof r.distKm === "number";
      const d = hasDist ? (r.distKm * k).toFixed(r.distKm * k < 10 ? 1 : 0) : "";
      const distCell = hasDist ? `${d} ${units}<div class="muted">${Math.round(r.brg)}° ${compass(r.brg)}</div>` : `<span class="muted">—</span>`;
      const past = r.when.getTime() < Date.now();
      return `<tr>
        <td class="num">${esc(fmtUTC(r.when))}<div class="muted">${esc(fmtLocal(r.when))}${past ? " · started" : ""}</div></td>
        <td><span class="call">${esc(r.call)}</span>${r.name ? `<div class="muted">${esc(r.name)}</div>` : ""}</td>
        <td>${!isValidRef(r.ref) ? esc(r.ref) : `<a href="${esc(sotlasUrl(r.ref))}" target="_blank" rel="noopener noreferrer">${esc(r.ref)}</a>`}
            <div class="muted">${esc(r.summitName || r.details)}${r.grid ? " · " + esc(r.grid) : ""}</div></td>
        <td class="num">${distCell}</td>
        <td>${esc(r.freq)}${tagsHTML(r.freq)}</td>
        <td>${esc(r.comments)}${r.poster && r.poster.toUpperCase() !== r.call.toUpperCase() ? `<div class="muted">posted by ${esc(r.poster)}</div>` : ""}</td>
      </tr>`;
    }).join("");
  }

  let lastWild = [];
  function renderWild(list) {
    if (list) lastWild = list;
    const st = bmState();
    const shown = lastWild.filter(r => passesBM(r, st));
    $("wildWrap").hidden = !shown.length;
    $("wild").innerHTML = shown.map(r => `<tr>
      <td class="num">${esc(fmtUTC(r.when))}<div class="muted">${esc(fmtLocal(r.when))}</div></td>
      <td class="call">${esc(r.call)}</td>
      <td>${esc(r.ref)}<div class="muted">${esc(r.details)}</div></td>
      <td>${esc(r.freq)}${tagsHTML(r.freq)}</td>
      <td>${esc(r.comments)}</td></tr>`).join("");
  }

  document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    if (sortKey === th.dataset.sort) sortDir *= -1; else { sortKey = th.dataset.sort; sortDir = 1; }
    render($("units").value);
  }));
  $("units").addEventListener("change", () => { if (rows.length) render($("units").value); });

  const BM_KEY = "sotaAlertsNear.bm.v1";
  // "VHF/UHF only" is a shortcut: on = select exactly the VHF/UHF bands; off = clear the band selection.
  // It shows as on whenever the band selection is exactly the VHF/UHF set, however it was made.
  function syncVuOnly() {
    if (!$("vuOnly")) return;       // optional: an older index.html may not have it
    const sel = bmState().bands;
    $("vuOnly").checked = sel.length === LOCAL_VU.length && LOCAL_VU.every(b => sel.includes(b));
  }
  $("vuOnly")?.addEventListener("change", () => {
    const on = $("vuOnly").checked;
    document.querySelectorAll(".bandCb").forEach(c => c.checked = on && LOCAL_VU.includes(c.value));
    onBMChange();
  });
  function onBMChange() {
    syncVuOnly();
    saveJSON(BM_KEY, bmState());
    if (!$("results").hidden) render($("units").value);
    renderWild();
    if (map && !$("mapWrap").hidden) drawMap();
  }
  (() => {
    const saved = loadJSON(BM_KEY, null);
    if (saved) {
      document.querySelectorAll(".bandCb").forEach(c => c.checked = (saved.bands || []).includes(c.value));
      document.querySelectorAll(".modeCb").forEach(c => c.checked = (saved.modes || []).includes(c.value));
      $("incUnclear").checked = saved.unclear !== false;
    }
    syncVuOnly();
  })();
  document.querySelectorAll(".bandCb, .modeCb, #incUnclear").forEach(c => c.addEventListener("change", onBMChange));
  $("clearBM").addEventListener("click", () => {
    document.querySelectorAll(".bandCb, .modeCb").forEach(c => c.checked = false);
    onBMChange();
  });

  // ---------- Theme ----------
  const THEME_KEY = "sotaAlertsNear.theme";
  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $("themeBtn").textContent = t === "dark" ? "Light mode" : "Dark mode";
    $("themeBtn").setAttribute("aria-pressed", String(t === "dark"));
  }
  (() => {
    let saved = null; try { saved = localStorage.getItem(THEME_KEY); } catch {}
    setTheme(saved === "dark" || saved === "light" ? saved : "dark");   // default: dark
  })();
  $("themeBtn").addEventListener("click", () => {
    const t = effectiveTheme() === "dark" ? "light" : "dark";
    setTheme(t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  });

  // ---------- Shared: what is currently visible ----------
  let lastSearch = null;
  function visibleRows() {
    const st = bmState();
    return rows.filter(r => passesBM(r, st)).sort((a, b) => a.when - b.when);
  }
  function visibleWild() {
    const st = bmState();
    return lastWild.filter(r => passesBM(r, st));
  }

  // ---------- Export .txt ----------
  function pad(s, n) { s = String(s ?? ""); return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length); }
  function buildTxt() {
    const ls = lastSearch || {};
    const k = ls.units === "mi" ? 0.621371 : 1;
    const st = bmState();
    const L = [];
    L.push("SOTA ALERTS");
    L.push(`Generated: ${fmtUTC(new Date())}`);
    if (ls.mode === "region") L.push(`Area: ${ls.label}`);
    else if (ls.gridBox) L.push(`Area: inside grid ${ls.label}`);
    else if (ls.label) L.push(`Area: ${ls.radiusIn} ${ls.units} around ${ls.label}`);
    L.push(`Window: ${ls.aheadH >= 8760 ? "all posted alerts" : "next " + ls.aheadH + " h"}`);
    L.push(`Bands: regional only (${[...LOCAL_VU, ...LOCAL_HF].join(", ")})`);
    if (st.bands.length || st.modes.length) L.push(`Band/mode filter: ${[...st.bands, ...st.modes].join(", ")}${st.unclear ? " (+ unclear)" : ""}`);
    L.push("");
    const vr = visibleRows();
    L.push(`${vr.length} alert(s)`);
    L.push("-".repeat(110));
    L.push(pad("UTC", 18) + pad("Activator", 12) + pad("Summit", 14) + pad("Grid", 8) + pad("Dist", 10) + pad("Freq/mode", 26) + "Summit name");
    L.push("-".repeat(110));
    for (const r of vr) {
      const dist = typeof r.distKm === "number" ? `${(r.distKm * k).toFixed(0)}${ls.units === "mi" ? "mi" : "km"} ${compass(r.brg)}` : "";
      L.push(pad(fmtUTC(r.when), 18) + pad(r.call, 12) + pad(r.ref, 14) + pad(r.grid, 8) + pad(dist, 10) + pad(r.freq, 26) + (r.summitName || r.details));
      if (r.comments) L.push(" ".repeat(18) + "Comments: " + r.comments);
    }
    const vw = visibleWild();
    if (vw.length) {
      L.push("");
      L.push(`${vw.length} alert(s) without a fixed/located summit`);
      L.push("-".repeat(110));
      for (const r of vw) {
        L.push(pad(fmtUTC(r.when), 18) + pad(r.call, 12) + pad(r.ref, 14) + pad("", 8) + pad("", 10) + pad(r.freq, 26) + (r.details || ""));
        if (r.comments) L.push(" ".repeat(18) + "Comments: " + r.comments);
      }
    }
    L.push("");
    L.push("Source: SOTAwatch alerts via the SOTA API. Times are UTC.");
    return L.join("\r\n");
  }
  $("exportBtn").addEventListener("click", () => {
    const txt = buildTxt();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sota-alerts-${stamp}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus(`Exported ${visibleRows().length + visibleWild().length} alert(s) to ${a.download}.`);
  });

  // ---------- Map (Leaflet + OpenTopoMap, loaded on first use) ----------
  // Leaflet 1.9.4 ships with this page in vendor/leaflet/ (no CDN). Paths are relative to index.html.
  const LEAFLET_CSS = "vendor/leaflet/leaflet.css";
  const LEAFLET_JS = "vendor/leaflet/leaflet.js";
  let leafletReady = null, map = null, layer = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletReady) return leafletReady;
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = LEAFLET_JS;
      js.onload = () => resolve();
      js.onerror = () => { leafletReady = null; reject(new Error("Couldn't load vendor/leaflet/leaflet.js. Keep the vendor folder next to index.html")); };
      document.head.appendChild(js);
    });
    return leafletReady;
  }
  function pinIcon(n, color) {
    const svg = `<svg width="26" height="36" viewBox="0 0 26 36" xmlns="http://www.w3.org/2000/svg"><path d="M13 1C6.4 1 1 6.3 1 12.9 1 22 13 35 13 35s12-13 12-22.1C25 6.3 19.6 1 13 1z" fill="${color}" stroke="#fff" stroke-width="1.5"/></svg>`;
    return L.divIcon({ className: "pin", html: svg + `<b>${n > 1 ? n : "▲"}</b>`, iconSize: [26, 36], iconAnchor: [13, 35], popupAnchor: [0, -32] });
  }
  function drawMap() {
    const ls = lastSearch || {};
    const units = (ls.units || $("units").value) === "km" ? "km" : "mi";
    const k = units === "mi" ? 0.621371 : 1;
    if (!map) {
      map = L.map("map", { zoomControl: true });
      L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        subdomains: "abc", maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue("--area").trim() || "#0e7c7b";      // teal search area
    const pinColor = cs.getPropertyValue("--pin").trim() || "#1f5fa8";     // blue pins
    const bounds = [];
    let circle = null;

    // search-area overlay
    if (ls.center) {
      L.circleMarker([ls.center.lat, ls.center.lon], { radius: 5, color: accent, fillColor: accent, fillOpacity: 1, weight: 2 })
        .bindTooltip(el("span", { text: `Search center: ${ls.label}` })).addTo(layer);
      bounds.push([ls.center.lat, ls.center.lon]);
      if (ls.gridBox) {
        const b = [[ls.gridBox.minLat, ls.gridBox.minLon], [ls.gridBox.maxLat, ls.gridBox.maxLon]];
        L.rectangle(b, { color: accent, weight: 2, fill: false, dashArray: "6 4" }).addTo(layer);
        bounds.push(...b);
      } else if (ls.rKm) {
        circle = L.circle([ls.center.lat, ls.center.lon], { radius: ls.rKm * 1000, color: accent, weight: 2, fill: false, dashArray: "6 4" }).addTo(layer);
      }
    }

    // one pin per summit; several alerts on one summit share a numbered pin
    const groups = new Map();
    let unplaced = 0;
    for (const r of visibleRows()) {
      if (!isFinite(r.lat) || !isFinite(r.lon)) { unplaced++; continue; }
      if (!groups.has(r.ref)) groups.set(r.ref, []);
      groups.get(r.ref).push(r);
    }
    unplaced += visibleWild().length;
    for (const [ref, list] of groups) {
      const r0 = list[0];
      const dist = typeof r0.distKm === "number" ? ` · ${(r0.distKm * k).toFixed(r0.distKm * k < 10 ? 1 : 0)} ${units} ${compass(r0.brg)}` : "";
      // Popup is built from DOM nodes with textContent, so API text is never parsed as HTML.
      const popup = el("div", {}, [
        el("div", { cls: "pref" }, [el("a", { href: sotlasUrl(ref), text: ref, newTab: true })]),
        el("div", { text: r0.summitName || r0.details }),
        el("div", { cls: "pmeta", text: `${r0.grid}${dist}` }),
        ...list.map(r => el("div", { cls: "pa" }, [
          el("b", { text: r.call }), document.createTextNode(` · ${fmtUTC(r.when)}`), el("br"),
          document.createTextNode(fmtLocal(r.when)), el("br"),
          document.createTextNode(r.freq),
          ...(r.comments ? [el("br"), el("i", { text: r.comments })] : [])
        ]))
      ]);
      L.marker([r0.lat, r0.lon], { icon: pinIcon(list.length, pinColor), title: `${ref} (${list.length})` })
        .bindPopup(popup, { maxWidth: 280 }).addTo(layer);
      bounds.push([r0.lat, r0.lon]);
    }

    const placed = [...groups.values()].reduce((n, l) => n + l.length, 0);
    $("mapNote").textContent = `${placed} alert(s) on ${groups.size} summit(s)` +
      (unplaced ? ` · ${unplaced} not mapped (wildcard or unknown location)` : "") +
      " · follows the band/mode filter.";

    setTimeout(() => {
      map.invalidateSize();
      if (circle && !groups.size) map.fitBounds(circle.getBounds(), { padding: [20, 20] });
      else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      else if (bounds.length === 1) map.setView(bounds[0], 11);
      else map.setView([46.6, -120.5], 6);
    }, 0);
  }
  // The map opens automatically after every search; the button hides or re-shows it.
  async function showMap() {
    $("mapBtn").disabled = true;
    try {
      await loadLeaflet();
      $("mapWrap").hidden = false;
      $("mapBtn").textContent = "Hide map";
      drawMap();
    } catch (e) {
      $("mapWrap").hidden = true;
      $("mapBtn").textContent = "Show on map";
      setStatus(e.message + ".", "err");
    } finally {
      $("mapBtn").disabled = false;
    }
  }
  $("mapBtn").addEventListener("click", () => {
    if (!$("mapWrap").hidden) { $("mapWrap").hidden = true; $("mapBtn").textContent = "Show on map"; return; }
    showMap();
  });

  // ---------- Prefs ----------
  const PREF_FIELDS = ["mode", "grid", "gridScope", "region", "lat", "lon", "radius", "units", "ahead", "assocs"];
  const prefs = loadJSON(PREFS_KEY, {});
  for (const k of PREF_FIELDS) if (prefs[k] !== undefined) $(k).value = prefs[k];

  // Search area is capped at 250 miles (400 km) to match the regional band set.
  const MAX_RADIUS = { mi: 250, km: 400 };
  const maxRadius = () => MAX_RADIUS[$("units").value === "km" ? "km" : "mi"];
  function syncRadiusLimit() {
    const max = maxRadius();
    $("radius").max = String(max);
    if (parseFloat($("radius").value) > max) $("radius").value = String(max);
    const label = $("radiusMax");   // optional: an older index.html may not have it
    if (label) label.textContent = `(max ${max} ${$("units").value === "km" ? "km" : "mi"})`;
  }
  $("units").addEventListener("change", syncRadiusLimit);
  syncRadiusLimit();

  const HINTS = {
    grid: "Searches a radius around the grid's center, or only summits that fall inside the grid.",
    region: "W7W = whole association · W7W/MC = one region · W7W/MC-001 = one summit. No radius needed.",
    latlon: "Searches a radius around the point. “Use my location” fills these in."
  };
  function applyMode() {
    const m = $("mode").value;
    document.querySelectorAll("[data-mode]").forEach(el => {
      el.hidden = !el.dataset.mode.split(" ").includes(m);
    });
    // radius is irrelevant when limiting to inside a grid
    const radiusEl = document.querySelector("[data-radius]");
    if (m === "grid" && $("gridScope").value === "inside") radiusEl.hidden = true;
    $("here").hidden = m === "region";
    $("modeHint").textContent = HINTS[m];
  }
  $("mode").addEventListener("change", applyMode);
  $("gridScope").addEventListener("change", applyMode);
  applyMode();

  $("here").addEventListener("click", () => {
    if (!navigator.geolocation) { setStatus("Geolocation isn't available in this browser.", "warn"); return; }
    setStatus("Getting your location…");
    navigator.geolocation.getCurrentPosition(p => {
      // rounded to ~1 km: enough for a summit radius search, and this is what is saved in the browser
      $("lat").value = p.coords.latitude.toFixed(2);
      $("lon").value = p.coords.longitude.toFixed(2);
      $("grid").value = latLonToGrid(p.coords.latitude, p.coords.longitude);
      setStatus(`Location set: ${$("grid").value}. Press Search.`);
    }, e => setStatus("Couldn't get location: " + e.message, "warn"), { timeout: 15000 });
  });

  $("clearCache").addEventListener("click", () => {
    for (const k of Object.keys(coordCache)) delete coordCache[k];
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    setStatus("Cached summit coordinates cleared.");
  });

  $("stop").addEventListener("click", () => { if (abortCtl) abortCtl.abort(); });

  // ---------- Main search ----------
  $("f").addEventListener("submit", async ev => {
    ev.preventDefault();

    const mode = $("mode").value;
    const units = $("units").value;
    const aheadH = Number($("ahead").value);
    const assocFilter = $("assocs").value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

    // ---- Resolve the search area for the chosen mode ----
    let center = null, label = "", rKm = null, gridBox = null, radiusIn = null, targets = null;
    if (mode === "region") {
      const raw = $("region").value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      targets = [];
      for (const t of raw) {
        const m = t.match(/^([A-Z0-9]{1,4})(?:\/([A-Z0-9]{1,3})(?:-(\d{1,3}|X+))?)?$/);
        if (!m) { setStatus(`"${t}" doesn't look like an association, region or summit (e.g. W7W, W7W/MC, W7W/MC-001).`, "err"); return; }
        targets.push({ assoc: m[1], region: m[2] || null, num: m[3] ? m[3].padStart(3, "0") : null, text: t });
      }
      if (!targets.length) { setStatus("Enter at least one association or region, e.g. W7W/MC.", "err"); return; }
      label = targets.map(t => t.text).join(", ");
    } else {
      if (mode === "grid") {
        const g = $("grid").value.trim();
        center = gridToLatLon(g);
        if (!center) { setStatus("Enter a valid grid locator (e.g. CN96, CN96tm).", "err"); return; }
        label = g.slice(0, 2).toUpperCase() + g.slice(2, 4) + g.slice(4, 6).toLowerCase() + g.slice(6);
        if ($("gridScope").value === "inside") gridBox = center.box;
      } else {
        const la = parseFloat($("lat").value), lo = parseFloat($("lon").value);
        if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
          setStatus("Enter a valid latitude and longitude.", "err"); return;
        }
        center = { lat: la, lon: lo };
        label = `${la.toFixed(3)}, ${lo.toFixed(3)} (${latLonToGrid(la, lo)})`;
      }
      if (gridBox) {
        // circle that encloses the grid box, used only for the association pre-filter
        rKm = distanceKm(center, { lat: gridBox.maxLat, lon: gridBox.maxLon }) + 1;
      } else {
        radiusIn = parseFloat($("radius").value);
        if (!(radiusIn > 0) || radiusIn > maxRadius()) { setStatus(`Radius must be between 1 and ${maxRadius()} ${units === "km" ? "km" : "miles"}.`, "err"); return; }
        rKm = units === "mi" ? radiusIn / 0.621371 : radiusIn;
      }
    }

    const p = {}; for (const k of PREF_FIELDS) p[k] = $(k).value; saveJSON(PREFS_KEY, p);

    lastSearch = { mode, label, center, gridBox, rKm, radiusIn, units, aheadH, at: new Date() };
    $("toolbar").hidden = true; $("mapWrap").hidden = true; $("mapBtn").textContent = "Hide map";
    abortCtl = new AbortController();
    const signal = abortCtl.signal;
    $("go").disabled = true; $("stop").disabled = false;
    $("results").hidden = true; $("summary").innerHTML = ""; $("filterNote").hidden = true; renderWild([]);
    rows = [];

    const summitLabel = c => c && c.name ? `${c.name}${c.altM !== "" ? ", " + c.altM + " m" : ""}${c.points !== "" ? ", " + c.points + " pts" : ""}` : "";

    try {
      // 1) Alerts
      setStatus("Fetching alerts from SOTAwatch…");
      const { data: rawAlerts } = await firstWorking(ALERT_URLS, signal);
      const list = Array.isArray(rawAlerts) ? rawAlerts : (rawAlerts.alerts || []);
      const now = Date.now();
      const tLo = now - PAST_GRACE_H * 3600e3, tHi = now + aheadH * 3600e3;
      let alerts = list.map(normAlert).filter(a => a.assoc && a.code && !isNaN(a.when) && a.when.getTime() >= tLo && a.when.getTime() <= tHi);
      const totalInWindow = alerts.length;

      // ===== Association / Region mode: match by reference, no geometry needed =====
      if (mode === "region") {
        alerts = alerts.filter(a => targets.some(t => {
          if (a.assoc !== t.assoc) return false;
          if (!t.region) return true;
          const [reg, num] = a.code.split("-");
          if (reg !== t.region) return false;
          if (!t.num) return true;
          return num === t.num || isWildcard(num || "");
        }));
        // best-effort lookups for summit name + grid (cached afterwards)
        const refs = [...new Set(alerts.filter(a => !isWildcard(a.code)).map(a => a.ref))];
        const coords = {};
        if (refs.length) {
          await pool(refs, CONCURRENCY, async ref => { coords[ref] = await summitCoords(ref, signal); },
            (d, t) => setStatus(`Looking up summit details… ${d}/${t}`));
          saveJSON(CACHE_KEY, coordCache);
        }
        for (const a of alerts) {
          const c = coords[a.ref];
          rows.push({ ...a, summitName: summitLabel(c), grid: c ? latLonToGrid(c.lat, c.lon) : "", lat: c?.lat, lon: c?.lon });
        }
        const longHaul = rows.filter(r => !isRegional(r)).length;
        rows = rows.filter(isRegional);
        $("results").hidden = false; $("toolbar").hidden = false;
        render(units);
        $("summary").innerHTML = [
          `Area: ${label}`,
          `Showing ${rows.length} result${rows.length === 1 ? "" : "s"} out of ${totalInWindow} worldwide`
        ].map(c => `<span class="chip">${esc(c)}</span>`).join("");
        setStatus(`Done at ${new Date().toLocaleTimeString()}.` + longHaulNote(longHaul));
        showMap();
        return;
      }

      // ===== Grid / Lat-Lon modes: geometry =====
      // 2) Association pre-filter
      let assocSet = null, assocNote = "";
      if (assocFilter.length) {
        assocSet = new Set(assocFilter);
        assocNote = `associations: ${assocFilter.join(", ")}`;
      } else {
        setStatus(`Got ${totalInWindow} alerts in window. Narrowing by association bounds…`);
        try {
          const assocs = await getJSON(ASSOC_URL, signal);
          assocSet = new Set();
          for (const a of (Array.isArray(assocs) ? assocs : [])) {
            const code = String(pick(a, "associationCode", "AssociationCode", "code") || "").toUpperCase();
            const box = {
              minLat: Number(pick(a, "minLat", "MinLat")), maxLat: Number(pick(a, "maxLat", "MaxLat")),
              minLon: Number(pick(a, "minLong", "MinLong", "minLon")), maxLon: Number(pick(a, "maxLong", "MaxLong", "maxLon"))
            };
            if (!code || ![box.minLat, box.maxLat, box.minLon, box.maxLon].every(isFinite)) continue;
            if (bboxOverlapsCircle(box, center, rKm)) assocSet.add(code);
          }
          if (!assocSet.size) assocSet = null; // unexpected shape; fall through
          else assocNote = `nearby associations: ${[...assocSet].sort().join(", ")}`;
        } catch (e) {
          if (e.name === "AbortError") throw e;
          assocSet = null;
        }
      }
      if (assocSet) alerts = alerts.filter(a => assocSet.has(a.assoc));

      // 3) Split wildcard vs real summits; look up coordinates
      const wild = alerts.filter(a => isWildcard(a.code));
      const fixed = alerts.filter(a => !isWildcard(a.code));
      let refs = [...new Set(fixed.map(a => a.ref))];
      let capped = false;
      if (!assocSet && refs.length > NO_FILTER_CAP) { refs = refs.slice(0, NO_FILTER_CAP); capped = true; }

      const uncached = refs.filter(r => !coordCache[r]).length;
      setStatus(`Looking up ${refs.length} summits (${uncached} not cached)…`);
      const coords = {};
      await pool(refs, CONCURRENCY, async ref => { coords[ref] = await summitCoords(ref, signal); },
        (d, t) => setStatus(`Looking up summit coordinates… ${d}/${t}`));
      saveJSON(CACHE_KEY, coordCache);

      // 4) Area filter
      const unlocated = [];
      for (const a of fixed) {
        const c = coords[a.ref];
        if (!c) { if (refs.includes(a.ref)) unlocated.push(a); continue; }
        const dist = distanceKm(center, c);
        const inside = gridBox
          ? (c.lat >= gridBox.minLat && c.lat < gridBox.maxLat && c.lon >= gridBox.minLon && c.lon < gridBox.maxLon)
          : dist <= rKm;
        if (inside) {
          rows.push({ ...a, distKm: dist, brg: bearingDeg(center, c), summitName: summitLabel(c), grid: latLonToGrid(c.lat, c.lon), lat: c.lat, lon: c.lon });
        }
      }

      const placed = [...wild, ...unlocated];
      const longHaul = rows.filter(r => !isRegional(r)).length + placed.filter(r => !isRegional(r)).length;
      rows = rows.filter(isRegional);
      $("results").hidden = false; $("toolbar").hidden = false;
      render(units);
      renderWild(placed.filter(isRegional).sort((a, b) => a.when - b.when));

      const chips = [
        gridBox ? `Inside grid ${label}` : `Center: ${label}`,
        gridBox ? "distance from grid center" : `Radius: ${radiusIn} ${units}`,
        `Showing ${rows.length} result${rows.length === 1 ? "" : "s"} out of ${totalInWindow} worldwide`
      ];
      if (assocNote) chips.push(assocNote);
      $("summary").innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join("");

      let msg = `Done at ${new Date().toLocaleTimeString()}.`, kind = "";
      if (!assocSet) { msg += " Association bounds were unavailable, so all alerted summits were checked."; kind = "warn"; }
      if (capped) { msg += ` Only the first ${NO_FILTER_CAP} summits were checked; add an association filter for complete results.`; kind = "warn"; }
      if (unlocated.length) { msg += ` ${unlocated.length} alert(s) couldn't be located and are listed below.`; }
      msg += longHaulNote(longHaul);
      setStatus(msg, kind);
      showMap();
    } catch (e) {
      if (e.name === "AbortError") setStatus("Stopped.", "warn");
      else if (e.isNet || e instanceof TypeError) setStatus("Couldn't reach the SOTA API (network or CORS block). If you opened this as a local file, try serving it from a web server or GitHub Pages.\n" + e.message, "err");
      else setStatus("Error: " + e.message, "err");
    } finally {
      $("go").disabled = false; $("stop").disabled = true; abortCtl = null;
    }
  });
})();
