# Summit Lookout

**Find upcoming SOTA activations by grid square, region, or location.**

Summit Lookout is a small, static web app for [Summits on the Air (SOTA)](https://www.sota.org.uk/) chasers. It searches [SOTAwatch](https://sotawatch.sota.org.uk/) **alerts** (planned activations) for a grid square, an association or region, or a point on the map. You can filter the results by band and mode, view them on a topographic map, or export them to a text file.

It runs entirely in your browser. There's no server, no account, no API key, and no tracking.

**Live site:** `https://marracci.github.io/sota-near-me/`

![Summit Lookout screenshot](docs/screenshot.png)

---

## Disclaimer

Summit Lookout is an independent project. It is **not affiliated with or endorsed by** Summits on the Air (SOTA), SOTAwatch, SOTLAS or OpenTopoMap. "Summits on the Air" and "SOTA" are names of the SOTA programme.

Alert times, frequencies and locations are whatever activators posted. Always confirm on air.

## Features

- **Three ways to search**
  - **Grid square:** any Maidenhead locator from 4 to 10 characters (e.g. `CN96`, `CN96tm`). Search a radius around the grid's center, or only summits inside the square.
  - **Association / Region / Summit:** `W7W` (whole association), `W7W/MC` (one region), or `W7W/MC-001` (one summit). Separate several with commas.
  - **Latitude / Longitude:** a point and a radius, with an optional "Use my location" button.
- **Look-ahead window:** the next 24 hours, 3 days, 7 days, 30 days, or every posted alert.
- **Band and mode filters:** 160m–23cm; CW, SSB, FM, AM, Data and DV. Filters apply instantly and don't re-query the API.
- **Map view:** pins on [OpenTopoMap](https://opentopomap.org/) tiles via [Leaflet](https://leafletjs.com/), with the search radius or grid outline drawn on the map. Several alerts on the same summit share one numbered pin.
- **Export:** saves the current, filtered results to a plain `.txt` list.
- **Distance and bearing** from your search point to each summit, in miles or kilometres.
- **Light and dark themes**, remembered between visits.
- **Wildcard alerts** (e.g. `W7W/MC-XXX`) are listed separately rather than dropped.

## How it works

Nothing is fetched until you press **Search alerts**. Then the app:

1. Downloads the current alert list from the SOTA API.
2. In region mode, matches alerts by reference. No coordinates are needed.
3. In grid and lat/lon modes, narrows the list to associations whose bounding box overlaps your search area, looks up coordinates for each alerted summit, and keeps the ones inside your radius or grid.
4. Caches summit coordinates in your browser, so later searches make fewer API calls.

### Band and mode detection

SOTAwatch alert frequencies are free text, so the app infers band and mode from what the activator typed (`14.062-cw`, `7.2ssb`, `2m fm`, `40-cw 20-cw`, `hf ssb`, and so on). Each result shows the tags it detected. Alerts with no usable frequency are tagged *unclear*, and a toggle controls whether those stay in the list.

Band and mode are matched independently. An alert for `7.032-cw, 146.52-fm` will pass a "2m + CW" filter.

## Using it locally

The app is plain HTML, CSS and JavaScript with no build step.<br>
You can simply clone locally, and open the `index.hmtl` to run. This is simplicity by design.

Serving it over HTTP is more reliable, though, because some browsers restrict `file://` pages:

```bash
git clone https://github.com/<username>/<repo>.git
cd <repo>/docs
python3 -m http.server 8000
# open http://localhost:8000
```


## Security and privacy

- **Content Security Policy:** only the site's own scripts and styles can run. Network access is limited to the SOTA API hosts and OpenTopoMap tiles.
- **Untrusted data is never rendered as HTML.** API text is escaped in tables, and map popups are built from DOM text nodes. This also avoids [CVE-2025-69993](https://nvd.nist.gov/vuln/detail/CVE-2025-69993), a `bindPopup()` XSS issue in Leaflet ≤ 1.9.4.
- **Validated references:** summit references from the API must match the `ASSOC/RG-123` format before they're used in a request URL, and each path segment is encoded.
- **No credentials or cookies** are sent to any API.
- **Location:** "Use my location" runs only when you click it, and it's **rounded to about 1 km** before it's shown or saved.
- **Local storage:** your last search, theme, band/mode filters and a cache of summit coordinates are kept in your browser's `localStorage`. Nothing is sent anywhere else. Clear the coordinate cache from *How this works / troubleshooting* on the page.

Found a security issue? Please open a private security advisory on this repo rather than a public issue.

## Known limitations

- **Not every activation is alerted.** Many activators post spots without an alert, and those won't appear here. For live spots, use [SOTAwatch](https://sotawatch.sota.org.uk/), [SOTLAS](https://sotl.as/) or [HamAlert](https://hamalert.org/).
- **The SOTA API has no published specification.** Endpoints or response fields may change without notice. The app tries fallback endpoints and reports errors in the status line.
- **Wildcard alerts** (`-XXX`) can't be placed on the map or measured for distance.
- **Band and mode detection** is heuristic. See [Band and mode detection](#band-and-mode-detection).
- **OpenTopoMap** is a free, volunteer-run service. Tiles may load slowly at busy times, and the maximum zoom is 17.

## Data sources and credits

- **Alerts and summit data:** [Summits on the Air](https://www.sota.org.uk/) via the SOTAwatch / SOTA API. All SOTA data belongs to the SOTA programme and is loaded live; this repository contains no SOTA data.
- **Summit coordinates (fallback):** [SOTLAS](https://sotl.as/), which also provides the summit links.
- **Map tiles:** © [OpenTopoMap](https://opentopomap.org/) ([CC-BY-SA](https://creativecommons.org/licenses/by-sa/3.0/)). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, SRTM.
- **Mapping library:** [Leaflet](https://leafletjs.com/) 1.9.4, BSD-2-Clause, © Volodymyr Agafonkin and contributors. Its license is at `docs/vendor/leaflet/LICENSE`.

Please use these free services considerately. The app queries only when you press Search and caches summit coordinates to keep load low.


## License

[MIT](LICENSE) © 2026 B.J. Marraccini

73! KD7MTN
