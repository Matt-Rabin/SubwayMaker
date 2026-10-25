'use strict';
// 3D basemap (MapLibre + OpenStreetMap vector tiles) with the network drawn on a projected overlay canvas.

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const LOCAL_TILES = new Set(['nyc', 'chi', 'sf', 'la', 'bos', 'sea', 'phl', 'dc', 'pit', 'tor', 'mtl', 'van']);   // cities with data/tiles/<id>.pmtiles (tools/build_tiles.py)
const BOUNDS_PAD = 3000;                // m the camera may stray past the census bbox; the tiles cover ~4 km
const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
// Python's http.server ignores Range headers, so fetch the archive once and slice it
// ponytail: whole archive in memory (~100 MB for NYC); use pmtiles' default FetchSource behind a range-capable server
function wholeFileSource(url) {
  let buf;
  return { getKey: () => url, getBytes: async (offset, length) => ({ data: (await (buf ||= fetch(url).then(r => r.arrayBuffer()))).slice(offset, offset + length) }) };
}
const overlay = document.getElementById('net');
const ctx = overlay.getContext('2d');
let map = null, mapReady = false, CW = 0, CH = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  CW = overlay.clientWidth; CH = overlay.clientHeight;
  overlay.width = CW * dpr; overlay.height = CH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  needsDraw = true;
}
window.addEventListener('resize', resize);

// world (m) <-> screen (px)
// alt: metres above the ground (elevated track), following 3D terrain when it's on
// Ph is the homogeneous screen point [x·w, y·w, w], what map.project computes before its divide
function Ph(x, y, alt = 0) {
  const tr = map.transform, l = maplibregl.LngLat.convert(G.city.toLngLat(x, y)), c = tr.locationCoordinate(l);
  const z = (map.terrain ? map.terrain.getElevationForLngLatZoom(l, tr.tileZoom) : 0) + alt;
  const m = map.terrain || alt ? tr.pixelMatrix3D : tr.pixelMatrix, X = c.x * tr.worldSize, Y = c.y * tr.worldSize;
  return [m[0] * X + m[4] * Y + m[8] * z + m[12], m[1] * X + m[5] * Y + m[9] * z + m[13], m[3] * X + m[7] * Y + m[11] * z + m[15]];
}
// Points behind the camera (w <= 0) divide to a mirrored spot on screen, so lines through them shot off across the
// view when zoomed in on a pitched map. They come back as NaN, which canvas calls and hit tests ignore;
// pathPts / clipNear cut segments at this plane instead. Visible ground is at w ≳ 0.6 × this distance.
const nearW = () => map.transform.cameraToCenterDistance * 0.1;
function P(x, y, alt = 0) {
  const h = Ph(x, y, alt);
  return h[2] > nearW() ? [h[0] / h[2], h[1] / h[2]] : [NaN, NaN];
}
// a segment between two Ph points cut where it passes behind the camera: [ax, ay, bx, by, cutA, cutB], or null
function clipNear(a, b) {
  const n = nearW(), cut = (p, q) => { const u = (n - p[2]) / (q[2] - p[2]); return p.map((v, i) => v + (q[i] - v) * u); };
  if (a[2] <= n && b[2] <= n) return null;
  const ca = a[2] < n, cb = b[2] < n;
  if (ca) a = cut(a, b); else if (cb) b = cut(b, a);
  return [a[0] / a[2], a[1] / a[2], b[0] / b[2], b[1] / b[2], ca, cb];
}
const DECK = 9;   // elevated deck height, m
const altOf = type => type === 'elevated' ? DECK : 0;
// screen positions of a station platform's two ends
function stationEnds(s, ang = s.ang || 0, type = s.type) {
  const c = Math.cos(ang) * plen(s) / 2, si = Math.sin(ang) * plen(s) / 2, alt = altOf(type);
  return [P(s.x - c, s.y - si, alt), P(s.x + c, s.y + si, alt)];
}
const PLAN_BLUE = '#2f6fe0';
const nodeAlt = s => s.junction || s.end ? (G.tracks.some(t => (t.a === s.id || t.b === s.id) && t.type === 'elevated') ? DECK : 0) : altOf(s.type);
function Wpt(px, py) { const ll = map.unproject([px, py]); return G.city.toXY(ll.lng, ll.lat); }
function pxPerM() { return 512 * Math.pow(2, map.getZoom()) / (40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180)); }

// ---------- graphics settings: satellite imagery, 3D terrain, textured buildings (saved per browser)
const GFX = { satellite: false, terrain: false, textures: false };
try { Object.assign(GFX, JSON.parse(localStorage.getItem('subwaybuilder:gfx')) || {}); } catch (e) { }
function setGfx(key, on) {
  GFX[key] = on;
  try { localStorage.setItem('subwaybuilder:gfx', JSON.stringify(GFX)); } catch (e) { }
  applyGfx();
}
// procedural facade textures: glass towers, concrete offices, brick walk-ups
function facade(kind) {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), rnd = mulberry32(kind.length * 97);
  const spec = {
    glass: { wall: '#4f6b82', win: () => `hsl(205,${25 + rnd() * 20}%,${42 + rnd() * 30}%)`, cols: 8, rows: 8, gap: 1 },
    office: { wall: '#bdb6aa', win: () => `hsl(210,15%,${22 + rnd() * 25}%)`, cols: 6, rows: 8, gap: 3 },
    brick: { wall: '#94553f', win: () => (rnd() < 0.25 ? '#f1d9a0' : `hsl(30,10%,${18 + rnd() * 18}%)`), cols: 4, rows: 6, gap: 5 },
  }[kind];
  g.fillStyle = spec.wall; g.fillRect(0, 0, S, S);
  if (kind === 'brick') for (let y = 0; y < S; y += 3) { g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`; g.fillRect(0, y, S, 1); }
  const cw = S / spec.cols, rh = S / spec.rows;
  for (let r = 0; r < spec.rows; r++) for (let k = 0; k < spec.cols; k++) {
    g.fillStyle = spec.win();
    g.fillRect(k * cw + spec.gap / 2, r * rh + spec.gap / 2 + (kind === 'glass' ? 0 : 1), cw - spec.gap, rh - spec.gap - (kind === 'glass' ? 0 : 2));
  }
  return g.getImageData(0, 0, S, S);
}
function setupGfx() {
  map.addSource('satellite', {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  });
  map.addSource('dem', {
    type: 'raster-dem', tileSize: 256, maxzoom: 15, encoding: 'terrarium',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    attribution: 'Terrain: Mapzen / AWS Open Data (USGS, SRTM)',
  });
  map.addSource('dem-hs', { type: 'raster-dem', tileSize: 256, maxzoom: 15, encoding: 'terrarium', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'] });
  const firstRoad = map.getStyle().layers.find(l => l['source-layer'] === 'transportation').id;
  map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.1 } }, firstRoad);
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5a5040' } }, firstRoad);
  for (const k of ['glass', 'office', 'brick']) map.addImage('tex-' + k, facade(k));
  applyGfx();
}
function applyGfx() {
  if (!mapReady) return;
  const vis = on => on ? 'visible' : 'none';
  map.setLayoutProperty('satellite', 'visibility', vis(GFX.satellite));
  map.setLayoutProperty('hillshade', 'visibility', vis(GFX.terrain && !GFX.satellite));
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', vis(!GFX.satellite));
  for (const l of map.getStyle().layers)   // roads fade over imagery so the photo reads, like an earth viewer
    if (l.type === 'line' && l['source-layer'] === 'transportation' && !/rail/.test(l.id)) map.setPaintProperty(l.id, 'line-opacity', GFX.satellite ? 0.35 : 1);
  map.setTerrain(GFX.terrain ? { source: 'dem', exaggeration: 1.3 } : null);
  if (map.getLayer('building-3d')) {
    const h = ['coalesce', ['get', 'render_height'], 0];
    map.setPaintProperty('building-3d', 'fill-extrusion-pattern', GFX.textures ? ['case', ['>=', h, 70], 'tex-glass', ['>=', h, 25], 'tex-office', 'tex-brick'] : undefined);
    map.setPaintProperty('building-3d', 'fill-extrusion-opacity', GFX.textures || GFX.satellite ? 0.95 : ['interpolate', ['linear'], ['zoom'], 13, 0.55, 15, 0.8]);
  }
  if (map.getLayer('demo-bld')) map.setPaintProperty('demo-bld', 'fill-extrusion-opacity', GFX.textures || GFX.satellite ? 0.95 : ['interpolate', ['linear'], ['zoom'], 13, 0.55, 15, 0.8]);
  try { map.setSky(GFX.terrain || GFX.satellite ? { 'sky-color': '#7fb2e5', 'horizon-color': '#dde8f2', 'fog-color': '#dde8f2', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 } : undefined); } catch (e) { }
  waterCache.clear();
}

function initMap(C, cam) {
  if (map) map.remove();
  mapReady = false;
  waterCache.clear();
  const local = LOCAL_TILES.has(C.id);
  map = new maplibregl.Map({
    container: 'map', style: local ? undefined : MAP_STYLE, center: cam ? cam.center : C.toLngLat(...C.cbd), zoom: cam ? cam.zoom : 13,
    pitch: cam ? cam.pitch : 50, bearing: cam ? cam.bearing : -15, maxPitch: 60, boxZoom: false, doubleClickZoom: false,
    attributionControl: false, canvasContextAttributes: { antialias: true },
    fadeDuration: 0,   // tiles pop in instead of fading for 300 ms
    maxBounds: local ? [C.toLngLat(-BOUNDS_PAD, C.H + BOUNDS_PAD), C.toLngLat(C.W + BOUNDS_PAD, -BOUNDS_PAD)] : undefined,
  });
  if (local) {
    const url = `data/tiles/${C.id}.pmtiles`;
    if (!pmtilesProtocol.get(url)) pmtilesProtocol.add(new pmtiles.PMTiles(wholeFileSource(url)));
    map.setStyle(MAP_STYLE, { transformStyle: (_, s) => ({ ...s, sources: { ...s.sources, openmaptiles: { type: 'vector', url: 'pmtiles://' + url } } }) });
  }
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
  map.on('load', () => {
    const max = k => { const v = C.bgs.map(b => b[k]).sort((a, b) => a - b); return v[Math.floor(v.length * 0.98)] || 1; };
    const mp = max('pop'), mj = max('jobs');
    map.addSource('bgs', {
      type: 'geojson', data: {
        type: 'FeatureCollection',
        features: C.bgs.map(b => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: { pop: b.pop / mp, jobs: b.jobs / mj } })),
      },
    });
    const heat = (id, prop, rgb) => map.addLayer({
      id, type: 'heatmap', source: 'bgs', layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': ['min', 1.5, ['get', prop]],
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 9, 4, 16, 380],
        'heatmap-intensity': 0.55, 'heatmap-opacity': 0.75,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, `rgba(${rgb},0.25)`, 0.5, `rgba(${rgb},0.6)`, 1, `rgba(${rgb},0.95)`],
      },
    }, 'building');
    heat('heat-pop', 'pop', '232,96,40');
    heat('heat-jobs', 'jobs', '70,90,225');
    // drop the basemap's own transit lines so the player's network reads clearly
    for (const l of map.getStyle().layers) if (/transit_rail|^poi_/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    // buildings a preview or planned piece would demolish: red copies of their footprints, a hair larger than the original
    map.addSource('demo-bld', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'demo-bld', type: 'fill-extrusion', source: 'demo-bld', minzoom: 13,
      paint: { 'fill-extrusion-color': DEMO_RED, 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0 } });
    demoKey = '';
    if (map.getLayer('building-3d')) {
      map.setLayerZoomRange('building-3d', 13, 24);
      map.setPaintProperty('building-3d', 'fill-extrusion-opacity', ['interpolate', ['linear'], ['zoom'], 13, 0.55, 15, 0.8]);
    }
    // the city's existing real-world rail system (OpenStreetMap), shown by the "Existing transit" overlay
    map.addLayer({
      id: 'real-rail', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
      filter: ['match', ['get', 'class'], ['transit', 'rail'], true, false],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'subclass'], 'subway', '#d6281f', ['light_rail', 'tram'], '#1f8f3a', 'monorail', '#8a3fd1', '#41556b'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 4.5], 'line-opacity': ['match', ['get', 'brunnel'], 'tunnel', 0.75, 1],
      },
    });
    map.addLayer({
      id: 'real-stations', type: 'circle', source: 'openmaptiles', 'source-layer': 'poi', filter: ['match', ['get', 'class'], ['rail', 'railway'], true, false],
      layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 5], 'circle-color': '#fff', 'circle-stroke-color': '#222', 'circle-stroke-width': 1.5 },
    });
    map.addLayer({
      id: 'real-station-names', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 13, filter: ['match', ['get', 'class'], ['rail', 'railway'], true, false],
      layout: { visibility: 'none', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-anchor': 'left', 'text-offset': [0.8, 0] },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
    // scaled 3D model of elevated structures (deck, parapets, piers, station platforms)
    map.addSource('viaduct', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'viaduct', type: 'fill-extrusion', source: 'viaduct',
      paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-vertical-gradient': true },
    });
    viaductV = -1;
    mapReady = true;
    setupGfx();
    applyOverlayLayers();
  });
  // camera moves are applied inside the map's own frame, after the game loop's rAF: drawing here keeps the
  // network in step with the map instead of a frame behind (errors are caught so they can't stop the map)
  map.on('render', () => { try { draw(); } catch (e) { console.error(e); } });
  map.on('sourcedata', e => { if (e.sourceId === 'openmaptiles' && e.tile) { waterPolys = null; buildingsDirty = true; graphs.road.dirty = graphs.rail.dirty = true; } });
  C.waterAt = waterAt;
  C.buildingAt = buildingAt;
  C.nameAt = stationName;
}
function applyOverlayLayers() {
  if (!mapReady) return;
  for (const id of ['real-rail', 'real-stations', 'real-station-names']) map.setLayoutProperty(id, 'visibility', UI.overlay === 'transit' ? 'visible' : 'none');
  map.setLayoutProperty('heat-pop', 'visibility', UI.overlay === 'pop' ? 'visible' : 'none');
  map.setLayoutProperty('heat-jobs', 'visibility', UI.overlay === 'jobs' ? 'visible' : 'none');
}
function camState() {
  const c = map.getCenter();
  return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

// ---------- water: read from rendered OSM water polygons, cached once tiles are in
const waterCache = new Map();
function waterAt(x, y) {
  if (!mapReady) return 0;
  const key = Math.round(x / 40) + ',' + Math.round(y / 40);
  if (waterCache.has(key)) return waterCache.get(key);
  const [px, py] = P(x, y);
  const w = px < 0 || py < 0 || px > CW || py > CH ? sourceWaterAt(x, y)
    : map.queryRenderedFeatures([px, py], { layers: ['water'] }).length ? 1 : 0;
  if (map.getZoom() >= 11 && map.areTilesLoaded()) waterCache.set(key, w);
  return w;
}
// off-screen fallback: point-in-polygon against water polygons in loaded (not necessarily visible) tiles
let waterPolys = null;
function sourceWaterAt(x, y) {
  if (!waterPolys) {
    waterPolys = [];
    for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'water' })) {
      const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polys) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [lo, la] of rings[0]) { x0 = Math.min(x0, lo); x1 = Math.max(x1, lo); y0 = Math.min(y0, la); y1 = Math.max(y1, la); }
        waterPolys.push({ rings, x0, y0, x1, y1 });
      }
    }
  }
  const [lon, lat] = G.city.toLngLat(x, y);
  for (const p of waterPolys) {
    if (lon < p.x0 || lon > p.x1 || lat < p.y0 || lat > p.y1) continue;
    let inside = false;
    for (const ring of p.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    if (inside) return 1;
  }
  return 0;
}

// ---------- buildings (for demolition costs): OSM footprints from loaded tiles, bucketed in 100 m cells
// rings stay in lng/lat (converting every vertex made rebuilds ~100 ms); bboxes are in world metres
let buildings = null, buildingsDirty = true, buildingsAt = 0;
function buildingIndex() {
  if (buildings && (!buildingsDirty || performance.now() - buildingsAt < 1500)) return buildings;
  buildingsDirty = false; buildingsAt = performance.now();
  buildings = new Map();
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })) {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
      for (const [lo, la] of rings[0]) { lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); la0 = Math.min(la0, la); la1 = Math.max(la1, la); }
      const [x0, y0] = G.city.toXY(lo0, la1), [x1, y1] = G.city.toXY(lo1, la0);   // y points south
      const b = { id: f.id ?? `${Math.round(x0)},${Math.round(y0)}`, h: f.properties.render_height || 6, rings, x0, y0, x1, y1 };
      for (let i = Math.floor(x0 / 100); i <= Math.floor(x1 / 100); i++) for (let j = Math.floor(y0 / 100); j <= Math.floor(y1 / 100); j++) {
        const k = i * 100003 + j;
        if (!buildings.has(k)) buildings.set(k, []);
        buildings.get(k).push(b);
      }
    }
  }
  return buildings;
}
function buildingAt(x, y) {
  if (!mapReady) return null;
  for (const b of buildingIndex().get(Math.floor(x / 100) * 100003 + Math.floor(y / 100)) || []) {
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    const [lon, lat] = G.city.toLngLat(x, y);
    let inside = false;
    for (const ring of b.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    if (inside) return b;
  }
  return null;
}

// ---------- street and rail graphs from the OSM lines in loaded tiles
const ROAD_W = { motorway: 1, trunk: 0.95, primary: 0.9, secondary: 0.95, tertiary: 1, minor: 1.15 };   // prefer big streets
function osmSegs(weight) {
  const segs = [];
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' })) {
    const w = weight(f.properties);
    if (!w) continue;
    const g = f.geometry;
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) {
      let prev = null;
      for (const c of line) {
        const q = G.city.toXY(c[0], c[1]);
        if (prev && (q[0] !== prev[0] || q[1] !== prev[1])) segs.push({ ax: prev[0], ay: prev[1], bx: q[0], by: q[1], w, cuts: [0, 1] });
        prev = q;
      }
    }
  }
  return segs;
}
// split: join segments where they cross (vector tiles simplify streets, so crossings rarely share a vertex)
function lineGraph(segs, split) {
  if (split) {
    const cells = new Map();
    segs.forEach((sg, i) => {
      for (let x = Math.floor((Math.min(sg.ax, sg.bx) - 12) / 100); x <= Math.floor((Math.max(sg.ax, sg.bx) + 12) / 100); x++)
        for (let y = Math.floor((Math.min(sg.ay, sg.by) - 12) / 100); y <= Math.floor((Math.max(sg.ay, sg.by) + 12) / 100); y++) {
          const k = x + ',' + y;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
    });
    for (const list of cells.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = segs[list[i]], q = segs[list[j]];
      const rx = p.bx - p.ax, ry = p.by - p.ay, sx2 = q.bx - q.ax, sy2 = q.by - q.ay, den = rx * sy2 - ry * sx2;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((q.ax - p.ax) * sy2 - (q.ay - p.ay) * sx2) / den, u = ((q.ax - p.ax) * ry - (q.ay - p.ay) * rx) / den;
      const ep = 12 / Math.hypot(rx, ry), eq = 12 / Math.hypot(sx2, sy2);   // 12 m slack joins T-junctions that stop just short
      if (t < -ep || t > 1 + ep || u < -eq || u > 1 + eq) continue;
      p.cuts.push(Math.max(0, Math.min(1, t))); q.cuts.push(Math.max(0, Math.min(1, u)));
    }
  }
  const ids = new Map(), X = [], Y = [], adj = [];
  const node = (x, y) => {
    const k = Math.round(x / 6) + ',' + Math.round(y / 6);
    let i = ids.get(k);
    if (i === undefined) { i = X.length; ids.set(k, i); X.push(x); Y.push(y); adj.push([]); }
    return i;
  };
  const link = (a, b, w) => { if (a !== b) { adj[a].push(b, w); adj[b].push(a, w); } };
  for (const sg of segs) {
    const cuts = [...new Set(sg.cuts)].sort((a, b) => a - b);
    let prev = -1;
    for (const c of cuts) {
      const i = node(sg.ax + (sg.bx - sg.ax) * c, sg.ay + (sg.by - sg.ay) * c);
      if (prev >= 0) link(prev, i, Math.hypot(X[i] - X[prev], Y[i] - Y[prev]) * sg.w);
      prev = i;
    }
  }
  const grid = new Map(), gk = (i, j) => i + ',' + j;
  X.forEach((x, i) => { const k = gk(Math.floor(x / 40), Math.floor(Y[i] / 40)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const nearest = (x, y, r, skip = -1) => {
    let best = -1, bd = r;
    const ci = Math.floor(x / 40), cj = Math.floor(y / 40), n = Math.ceil(r / 40);
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) for (const i of grid.get(gk(ci + a, cj + b)) || []) {
      if (i === skip) continue;
      const d = Math.hypot(X[i] - x, Y[i] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  // tile clipping leaves dangling ends: stitch each to the nearest other node within 40 m
  for (let i = 0; i < X.length; i++) if (adj[i].length === 2) {
    const j = nearest(X[i], Y[i], 40, i);
    if (j >= 0 && j !== adj[i][0]) link(i, j, Math.hypot(X[j] - X[i], Y[j] - Y[i]));
  }
  return { X, Y, adj, nearest };
}
const graphs = { road: { dirty: true, at: 0 }, rail: { dirty: true, at: 0 } };
function cachedGraph(kind) {
  const c = graphs[kind];
  if (c.g && (!c.dirty || performance.now() - c.at < 1500)) return c.g;
  c.dirty = false; c.at = performance.now();
  c.g = kind === 'road' ? lineGraph(osmSegs(p => ROAD_W[p.class] || 0), true)
    : lineGraph(osmSegs(p => p.class === 'transit' || p.class === 'rail' ? 1 : 0), false);
  return c.g;
}
const roadGraph = () => cachedGraph('road');
// control points for a track from a to b that follows streets, or null
const TURN_PEN = 250;   // metres of detour a line will accept to avoid a 90° turn
function followRoad(a, b) {
  const g = roadGraph(), { X, Y, adj, nearest } = g;
  const s = nearest(a[0], a[1], 400), e = nearest(b[0], b[1], 400);
  if (s < 0 || e < 0) return null;
  // search over directed street segments so every change of direction can be charged for
  // (built once per graph: rebuilding them was most of each call)
  if (!g.edges) {
    const eFrom = [], eTo = [], eW = [], eAng = [], out = X.map(() => []);
    for (let u = 0; u < X.length; u++) for (let k = 0; k < adj[u].length; k += 2) {
      const v = adj[u][k];
      out[u].push(eFrom.length);
      eFrom.push(u); eTo.push(v); eW.push(adj[u][k + 1]); eAng.push(Math.atan2(Y[v] - Y[u], X[v] - X[u]));
    }
    g.edges = { eFrom, eTo, eW, eAng, out };
  }
  const { eFrom, eTo, eW, eAng, out } = g.edges;
  const dist = new Float64Array(eFrom.length).fill(Infinity), prev = new Int32Array(eFrom.length).fill(-1);
  const hd = [], hi = [];   // binary min-heap of (distance, edge)
  const push = (d, i) => {
    let k = hd.length; hd.push(d); hi.push(i);
    while (k > 0) { const p = (k - 1) >> 1; if (hd[p] <= hd[k]) break; [hd[p], hd[k]] = [hd[k], hd[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p; }
  };
  const pop = () => {
    const d = hd[0], i = hi[0], ld = hd.pop(), li = hi.pop();
    if (hd.length) {
      hd[0] = ld; hi[0] = li;
      for (let k = 0; ;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < hd.length && hd[l] < hd[m]) m = l;
        if (r < hd.length && hd[r] < hd[m]) m = r;
        if (m === k) break;
        [hd[m], hd[k]] = [hd[k], hd[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m;
      }
    }
    return [d, i];
  };
  for (const id of out[s]) { dist[id] = eW[id]; push(eW[id], id); }
  let goal = -1;
  while (hd.length) {
    const [d, id] = pop();
    if (d > dist[id]) continue;
    if (eTo[id] === e) { goal = id; break; }
    for (const f of out[eTo[id]]) {
      if (eTo[f] === eFrom[id]) continue;
      const turn = turnDeg(eAng[id], eAng[f]);
      const nd = d + eW[f] + (turn > 20 ? TURN_PEN * turn / 90 : 0);
      if (nd < dist[f]) { dist[f] = nd; prev[f] = id; push(nd, f); }
    }
  }
  if (s !== e && goal < 0) return null;
  const path = [];
  for (let id = goal; id >= 0; id = prev[id]) path.unshift([X[eTo[id]], Y[eTo[id]]]);
  path.unshift([X[s], Y[s]]);
  const pts = simplifyPath([a, ...path, b], 6);
  // drop street nodes that overshoot an endpoint, or the track would double back into the station
  while (pts.length > 2 && bendAngle(pts[0], pts[1], pts[2]) > 90) pts.splice(1, 1);
  while (pts.length > 2 && bendAngle(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]) > 90) pts.splice(pts.length - 2, 1);
  return pts.slice(1, -1).map(p => [p[0], p[1], MIN_RADIUS]);
}
// mouse-driven previews: recompute when the key changes, at most every 120 ms
function throttled(slot, key, fn) {
  if (key !== slot.key) {
    if (performance.now() - slot.at > 120) Object.assign(slot, { key, at: performance.now(), val: fn() });
    else needsDraw = true;   // stale for now: draw again next frame so the mouse's last position gets computed
  }
  return slot.val;
}
const roadPreview = { key: '', at: 0 }, costPreview = { key: '', at: 0 }, stationPreview = { key: '', at: 0 }, geomPreview = { key: '', at: 0 };
function followRoadCached(a, b) {
  return throttled(roadPreview, `${Math.round(a[0])},${Math.round(a[1])}|${Math.round(b[0] / 15)},${Math.round(b[1] / 15)}`, () => followRoad(a, b));
}

// ---------- import the real-world system (Existing transit overlay) into the plan, one click at a time
const realType = p => p.brunnel === 'tunnel' ? 'cutcover' : p.brunnel === 'bridge' ? 'elevated' : 'atgrade';
function importFromOverlay(px, py) {
  const feats = map.queryRenderedFeatures([[px - 6, py - 6], [px + 6, py + 6]], { layers: ['real-stations', 'real-rail'] });
  const st = feats.find(f => f.layer.id === 'real-stations'), line = feats.find(f => f.layer.id === 'real-rail');
  if (!st && !line) return false;
  const was = UI.plan;
  UI.plan = true;   // imports always land in the plan
  try { if (st) importStation(st); else importLine(line, ...Wpt(px, py)); } finally { UI.plan = was; }
  return true;
}
// real rail segments within r of (x, y), nearest first: [{ d, ang, type, x, y }] with (x, y) the closest point on the line
function railSegsNear(x, y, r) {
  const out = [];
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' })) {
    const p = f.properties, g = f.geometry;
    if (p.class !== 'transit' && p.class !== 'rail') continue;
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) {
      for (let k = 1; k < line.length; k++) {
        const [ax, ay] = G.city.toXY(line[k - 1][0], line[k - 1][1]), [bx, by] = G.city.toXY(line[k][0], line[k][1]);
        if (Math.min(ax, bx) > x + r || Math.max(ax, bx) < x - r || Math.min(ay, by) > y + r || Math.max(ay, by) < y - r) continue;
        const d = segDist(x, y, ax, ay, bx, by);
        if (d > r) continue;
        const dx = bx - ax, dy = by - ay, u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        out.push({ d, ang: Math.atan2(dy, dx), type: realType(p), x: ax + u * dx, y: ay + u * dy });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
// A real station becomes one platform per line it serves (lines crossing at an angle or on another level), each
// sitting on and lined up with its line. Platforms of one station, and real stations nearby, form a transfer complex.
function importStation(f) {
  const [x, y] = G.city.toXY(...f.geometry.coordinates), name = f.properties['name:en'] || f.properties.name;
  const lines = [];
  for (const sg of railSegsNear(x, y, 70)) if (!lines.some(l => l.type === sg.type && crossAngle(l.ang, sg.ang) < 25)) lines.push(sg);
  if (!lines.length) lines.push({ x, y, ang: 0, type: 'cutcover' });
  const made = [];
  for (const l of lines.slice(0, 3)) {
    if (G.stations.some(o => o.type === l.type && Math.hypot(o.x - l.x, o.y - l.y) < 60)) continue;   // already have this platform
    const on = G.tracks.map(t => [t, nearestOnTrack(t, l.x, l.y)]).filter(([, p]) => p.d < 30).sort((a, b) => a[1].d - b[1].d)[0];
    const opts = { name, sameName: made.length > 0 };
    const s = on ? buildStationOnTrack(on[0], l.x, l.y, l.type, opts) : buildStation(l.x, l.y, l.type, l.ang, opts);
    if (s) { if (made.length) linkStations(made[0], s); made.push(s); }
  }
  if (!made.length) return toast('That station is already in your network or plan', true);
  const near = linkNearby(made[0], TRANSFER_LINK);
  toast(`Added ${made[0].name} to the plan${made.length > 1 ? ` (${made.length} platforms)` : ''}${near.length ? ` — transfer with ${[...new Set(near.map(o => o.name))].join(', ')}` : ''}`);
}
function importLine(f, x, y) {
  const { X, Y, adj, nearest } = cachedGraph('rail'), n0 = nearest(x, y, 40);
  if (n0 < 0 || !adj[n0].length) return toast('Zoom in a little so the line is loaded, then click it again', true);
  // a station / track end on the stretch of line from node i to node j (line vertices can be far apart)
  const stops = [...G.stations, ...G.nodes.filter(n => n.end)];
  const stopOn = (i, j) => stops.filter(s => segDist(s.x, s.y, X[i], Y[i], X[j], Y[j]) < 60)
    .sort((p, q) => Math.hypot(p.x - X[i], p.y - Y[i]) - Math.hypot(q.x - X[i], q.y - Y[i]))[0];
  const dirOf = (a, b) => Math.atan2(Y[b] - Y[a], X[b] - X[a]);
  // follow the line from the click until it reaches a station or track end, a branch it can't pass straight through, or 8 km
  const walk = (prev, cur) => {
    const path = [];
    for (let len = 0; len < 8000;) {
      const stop = stopOn(prev, cur);
      if (stop) return { path, stop };
      path.push(cur);
      let next = -1, best = 35;
      for (let k = 0; k < adj[cur].length; k += 2) {
        const nb = adj[cur][k], turn = nb === prev ? 999 : turnDeg(dirOf(prev, cur), dirOf(cur, nb));
        if (turn < best) { best = turn; next = nb; }
      }
      if (next < 0) break;
      len += Math.hypot(X[next] - X[cur], Y[next] - Y[cur]);
      prev = cur; cur = next;
    }
    return { path, stop: null };
  };
  const nbs = [];
  for (let k = 0; k < adj[n0].length; k += 2) nbs.push(adj[n0][k]);
  const nA = nbs[0], back = dirOf(n0, nA) + Math.PI;
  const nB = nbs.slice(1).sort((p, q) => turnDeg(back, dirOf(n0, p)) - turnDeg(back, dirOf(n0, q)))[0];
  const wA = walk(n0, nA), wB = nB !== undefined && turnDeg(back, dirOf(n0, nB)) < 45 ? walk(n0, nB) : { path: [], stop: null };
  const ends = [wA.stop, wB.stop];
  if (ends[0] && ends[0] === ends[1]) return toast('That stretch is already connected', true);
  const pts = [...(ends[0] ? [[ends[0].x, ends[0].y]] : []), ...[...wA.path.reverse(), n0, ...wB.path].map(i => [X[i], Y[i]]), ...(ends[1] ? [[ends[1].x, ends[1].y]] : [])];
  if (polyLen(pts) < 100) return toast('Click the line between stations', true);
  const A = ends[0] || { id: -5, x: pts[0][0], y: pts[0][1], end: true }, B = ends[1] || { id: -6, x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], end: true };
  const type = realType(f.properties);
  for (const tol of [4, 10, 25, 50]) {   // coarser and coarser until the real alignment fits the curve rules
    const ctrl = simplifyPath(pts, tol).slice(1, -1).map(p => [p[0], p[1], MIN_RADIUS])
      .filter(c => Math.hypot(c[0] - A.x, c[1] - A.y) > clearOf(A) + 40 && Math.hypot(c[0] - B.x, c[1] - B.y) > clearOf(B) + 40);
    if (trackGeometry(A, ctrl, B).err) continue;
    const a = ends[0] || addEndNode(A.x, A.y), b = ends[1] || addEndNode(B.x, B.y);
    const t = buildTrack(a.id, b.id, ctrl, type);
    if (!t) { dropOrphanNodes(); reindex(); return; }
    return toast(`Added ${(t.len / 1000).toFixed(1)} km of ${TYPES[type].label.toLowerCase()} track to the plan`);
  }
  toast('That stretch has curves tighter than the minimum radius — trace it with the Track tool instead', true);
}

// ---------- control points: shown on every track while the Track tool is out, or on the selected track
function handleTracks() {
  if (map.getZoom() < 13) return [];
  if (UI.tool === 'track') return G.tracks;
  if (UI.tool === 'select' && UI.sel && UI.sel.kind === 'track' && TR(UI.sel.id)) return [TR(UI.sel.id)];
  return [];
}
function handleAt(px, py) {
  for (const t of handleTracks()) for (let i = 0; i < (t.ctrl || []).length; i++) {
    const [qx, qy] = P(t.ctrl[i][0], t.ctrl[i][1], altOf(t.type));
    if (Math.hypot(qx - px, qy - py) < 9) return { t: t.id, i };
  }
  return null;
}
function drawHandle(x, y, alt, active) {
  const [px, py] = P(x, y, alt);
  ctx.beginPath(); ctx.arc(px, py, active ? 7 : 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = PLAN_BLUE; ctx.lineWidth = 2.5; ctx.stroke();
}

// ---------- level changes along a track: ramps between deck and ground, tunnel portals where it goes underground
const isUnder = type => type === 'cutcover' || type === 'deep';
const RAMP = 150, PORTAL_OFF = 40;   // m to climb from ground to deck height; how far past a node's own clearance a portal sits
let profiles = { v: -1, m: new Map() };
// the level a track meets at node n: a station's own level, or the other track's at a junction / track end
function nodeLevel(n, t) {
  if (!n.end && !n.junction) return n.type;
  const o = G.tracks.find(o => o !== t && (o.a === n.id || o.b === n.id));
  return o ? o.type : t.type;
}
// Height along track t: { alt(s), pts3: [x, y, alt] points, portals: [{x, y, ang (direction the opening faces)}] }.
// Ramps are measured as distance d in from an end (end 0 = t.a, 1 = t.b).
function trackProfile(t) {
  if (profiles.v !== G.version) profiles = { v: G.version, m: new Map() };
  let pr = profiles.m.get(t.id);
  if (pr) return pr;
  const cum = [0];
  for (let i = 1; i < t.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]));
  const L = cum[cum.length - 1], base = altOf(t.type), ramps = [], portals = [];
  for (const [n, end] of [[ST(t.a), 0], [ST(t.b), 1]]) {
    if (!n) continue;
    const lvl = nodeLevel(n, t), endAlt = altOf(lvl), clear = clearOf(n), station = !n.end && !n.junction;
    const room = Math.max(20, L / 2 - clear - 10), ramp = Math.min(RAMP, room), off = Math.min(PORTAL_OFF, room);
    if (isUnder(t.type) !== isUnder(lvl)) {
      if (isUnder(t.type)) {   // dives underground leaving this node: down from the node's level, then the portal facing back at it
        const d = clear + (endAlt > 0 ? ramp : off);
        if (endAlt > 0) ramps.push({ end, d0: clear, d1: d, a0: endAlt, a1: 0 });
        portals.push({ end, d, toward: -1 });
      } else if (station) {    // above-ground track reaching an underground station: portal just before it, facing out along the track
        const d = clear + off;
        ramps.push({ end, d0: d, d1: d + ramp, a0: 0, a1: base });
        portals.push({ end, d, toward: 1 });
      } else if (base > 0) ramps.push({ end, d0: 0, d1: ramp, a0: 0, a1: base });   // the underground track at this joint has the portal
    } else if (endAlt !== base && (station || base > endAlt)) {   // elevated ↔ at-grade: just a ramp
      const d0 = station ? clear : 0;
      ramps.push({ end, d0, d1: d0 + ramp, a0: endAlt, a1: base });
    }
  }
  const alt = s => {
    for (const r of ramps) {
      const d = r.end ? L - s : s;
      if (d < r.d1) return d <= r.d0 ? r.a0 : r.a0 + (r.a1 - r.a0) * (d - r.d0) / (r.d1 - r.d0);
    }
    return base;
  };
  // the track's own points plus extra ones through each ramp, so slopes start and end where they should
  const extra = ramps.flatMap(r => [0, 0.25, 0.5, 0.75, 1].map(f => r.d0 + (r.d1 - r.d0) * f).map(d => r.end ? L - d : d)).filter(s => s > 0.5 && s < L - 0.5);
  const ss = [...cum.map((s, i) => [s, i]), ...extra.map(s => [s, -1])].sort((p, q) => p[0] - q[0]);
  const pts3 = ss.map(([s, i]) => { if (i >= 0) return [t.pts[i][0], t.pts[i][1], alt(s)]; const q = pointAtLength(t, s); return [q.x, q.y, alt(s)]; });
  pr = {
    alt, pts3, maxAlt: Math.max(...pts3.map(p => p[2])),
    portals: portals.map(p => {
      const q = pointAtLength(t, Math.max(0, Math.min(L, p.end ? L - p.d : p.d)));
      return { x: q.x, y: q.y, ang: q.ang + ((p.end ? -1 : 1) * p.toward < 0 ? Math.PI : 0), planned: !!t.planned };
    }),
  };
  profiles.m.set(t.id, pr);
  return pr;
}

// ---------- scaled 3D model of elevated structures, ramps and tunnel portals
let viaductV = -1;
function updateViaduct() {
  if (!mapReady || viaductV === G.version) return;
  viaductV = G.version;
  const C = G.city, feats = [];
  const box = (cx, cy, ang, len, wid, b, h, color) => {
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux, l = len / 2, w = wid / 2;
    const ring = [[l, w], [l, -w], [-l, -w], [-l, w], [l, w]].map(([p, q]) => C.toLngLat(cx + ux * p + nx * q, cy + uy * p + ny * q));
    feats.push({ type: 'Feature', properties: { b, h, color }, geometry: { type: 'Polygon', coordinates: [ring] } });
  };
  // a portal: concrete headwall with an opening, the dark mouth behind it, an earth-covered roof, trough walls on the approach
  const portal = p => {
    const ux = Math.cos(p.ang), uy = Math.sin(p.ang), at = (u, v) => [p.x + ux * u - uy * v, p.y + uy * u + ux * v];
    const [con, dark, earth] = p.planned ? ['#9db9e8', '#33415c', '#8fb0e6'] : ['#a8a6a0', '#121212', '#7d8873'];
    for (const v of [-6.2, 6.2]) box(...at(0, v), p.ang, 2.5, 3, 0, 7, con);          // pillars
    box(...at(0, 0), p.ang, 2.5, 15.4, 5.3, 7, con);                                    // lintel over the opening
    box(...at(-6.5, 0), p.ang, 10, 9.4, 0, 0.3, dark);                                  // the mouth, in shadow
    box(...at(-27, 0), p.ang, 30, 16, 0, 1.4, earth);                                   // tunnel roof, earth on top
    for (const v of [-5.2, 5.2]) box(...at(26, v), p.ang, 50, 0.8, 0, 1.3, con);        // retaining walls of the approach cut
  };
  for (const t of G.tracks) {
    const pr = trackProfile(t);
    pr.portals.forEach(portal);
    if (pr.maxAlt < 0.3) continue;
    const [deck, wall, pier, fill] = t.planned ? ['#8fb0e6', '#a9c3ee', '#86a5da', '#9db9e8'] : ['#9c9b96', '#b7b6b0', '#8f8e88', '#a39f95'];
    let sinceP = 15;
    for (let i = 1; i < pr.pts3.length; i++) {
      const [ax, ay, az] = pr.pts3[i - 1], [bx, by, bz] = pr.pts3[i], L = Math.hypot(bx - ax, by - ay);
      if (!L || Math.max(az, bz) < 0.3) { sinceP = 15; continue; }
      const ang = Math.atan2(by - ay, bx - ax), n = Math.ceil(L / (az === bz ? 40 : 15));   // shorter spans on slopes
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n, cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f, h = az + (bz - az) * f, len = L / n + 1;
        if (h >= 2.5) {   // deck on piers
          box(cx, cy, ang, len, 10, h - 1.4, h, deck);
          for (const side of [-4.8, 4.8]) box(cx - Math.sin(ang) * side, cy + Math.cos(ang) * side, ang, len, 0.4, h, h + 1.1, wall);
        } else if (h > 0.3) box(cx, cy, ang, len, 10, 0, h, fill);   // too low for piers: a solid ramp
      }
      for (let s = 30 - sinceP; s < L; s += 30) {   // piers every 30 m where the deck is high enough
        const f = s / L, px = ax + (bx - ax) * f, py = ay + (by - ay) * f, h = az + (bz - az) * f;
        if (h < 3.2) continue;
        box(px, py, ang, 2.2, 6.5, h - 2.2, h - 1.4, pier);
        box(px, py, ang, 1.8, 1.8, 0, h - 2.2, pier);
      }
      sinceP = (sinceP + L) % 30;
    }
  }
  for (const s of G.stations) {
    if (s.type !== 'elevated') continue;
    const ang = s.ang || 0, pl = !!s.planned;
    box(s.x, s.y, ang, plen(s) + 10, 20, DECK - 1.6, DECK + 0.3, pl ? '#9db9e8' : '#a9a7a0');   // platform
    box(s.x, s.y, ang, plen(s) - 10, 15, DECK + 3.8, DECK + 4.3, pl ? '#6f93d6' : '#55687a');   // canopy
    const e = plen(s) / 2 - 10;
    for (const [p, q] of [[-e, 8], [e, 8], [-e, -8], [e, -8], [0, 8], [0, -8]]) {
      const ux = Math.cos(ang), uy = Math.sin(ang);
      box(s.x + ux * p - uy * q, s.y + uy * p + ux * q, ang, 1.4, 1.4, 0, DECK + 3.8, pl ? '#86a5da' : '#7d7c77');
    }
  }
  map.getSource('viaduct').setData({ type: 'FeatureCollection', features: feats });
}

// ---------- station names from real street names nearby
const ABBR = [[/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Av'], [/\bBoulevard\b/g, 'Blvd'], [/\bRoad\b/g, 'Rd'], [/\bPlace\b/g, 'Pl'],
  [/\bParkway\b/g, 'Pkwy'], [/\bDrive\b/g, 'Dr'], [/\bSquare\b/g, 'Sq'], [/\bExpressway\b/g, 'Expy'], [/\bHighway\b/g, 'Hwy'], [/\bLane\b/g, 'Ln'],
  [/\bTerrace\b/g, 'Ter'], [/\bCourt\b/g, 'Ct'], [/^West (?=\d)/, 'W '], [/^East (?=\d)/, 'E '], [/^North (?=\d)/, 'N '], [/^South (?=\d)/, 'S ']];
const abbrev = n => ABBR.reduce((s, [a, b]) => s.replace(a, b), n);
function nearbyNames(x, y, layer, radius) {
  const best = new Map();
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: layer })) {
    const name = f.properties['name:en'] || f.properties.name;
    if (!name) continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Point' ? [[g.coordinates]] : [];
    let d = Infinity, ang = 0;
    for (const line of lines) {
      let prev = null;
      for (const c of line) {
        const p = G.city.toXY(c[0], c[1]);
        const dd = prev ? segDist(x, y, prev[0], prev[1], p[0], p[1]) : Math.hypot(p[0] - x, p[1] - y);
        if (dd < d) { d = dd; if (prev) ang = Math.atan2(p[1] - prev[1], p[0] - prev[0]); }
        prev = p;
      }
    }
    if (d < radius && d < (best.get(name)?.d ?? Infinity)) best.set(name, { d, ang });
  }
  return [...best.entries()].sort((a, b) => a[1].d - b[1].d).map(([n, v]) => ({ name: abbrev(n), ang: v.ang }));
}
// angle between two street directions, ignoring which way they run (0..90 degrees)
const crossAngle = (a, b) => { let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d * 180 / Math.PI; };
function stationName(x, y, taken) {
  const cands = [];
  const air = G.city.airportAt(x, y);
  if (air) cands.push(air.name);
  if (mapReady) {
    const st = nearbyNames(x, y, 'transportation_name', 220);
    const cross = st.length ? st.find(o => o.name !== st[0].name && crossAngle(o.ang, st[0].ang) > 35) : null;
    if (cross) cands.push(`${st[0].name}–${cross.name}`, `${cross.name}–${st[0].name}`);
    if (st.length) cands.push(st[0].name);
    const pl = nearbyNames(x, y, 'place', 1500).map(o => o.name);
    if (pl.length) { cands.push(pl[0]); if (st.length) cands.push(`${st[0].name}–${pl[0]}`); }
  }
  for (const c of cands) if (!taken.has(c)) return c;
  const base = cands[0] || 'Station';
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// ---------- geometry helpers
// Polylines are clipped to the canvas: on a pitched map, track near the horizon projects to ~1e6 px, and
// dashing all of that cost 0.25-1.2 s a frame. Set the dash pattern before calling: each visible piece
// starts a little early so its dashes line up with where they'd fall on the unclipped line.
// For strokes only: clipping leaves open pieces, so don't fill() what this builds.
const CLIP = 60;   // px beyond the canvas edge, wider than any stroke
function pathPts(pts, alt = 0) {
  ctx.beginPath();
  const period = ctx.getLineDash().reduce((a, b) => a + b, 0);
  let prev = null, along = 0, pen = false, t0, t1;
  const edge = (p, q) => {   // Liang–Barsky: narrow [t0, t1] to one side of the padded canvas
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  for (const pt of pts) {
    const q = Ph(pt[0], pt[1], pt[2] ?? alt), s = prev && clipNear(prev, q);
    if (s) {
      const [ax, ay, bx, by, cutA, cutB] = s, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      t0 = 0; t1 = 1;
      if (cutA) pen = false;
      if (edge(-dx, ax + CLIP) && edge(dx, CW + CLIP - ax) && edge(-dy, ay + CLIP) && edge(dy, CH + CLIP - ay)) {
        if (!pen) {
          const back = L && period ? Math.min((along + t0 * L) % period, t0 * L) / L : 0;
          ctx.moveTo(ax + dx * (t0 - back), ay + dy * (t0 - back));
        }
        ctx.lineTo(ax + dx * t1, ay + dy * t1);
        pen = t1 === 1 && !cutB;
      } else pen = false;
      along += L;
    } else pen = false;
    prev = q;
  }
}
// a ground circle as world points (stroke it with pathPts)
const ringPts = (x, y, r) => Array.from({ length: 49 }, (_, a) => [x + Math.cos(a / 48 * 6.2832) * r, y + Math.sin(a / 48 * 6.2832) * r]);
// filled ground circle, cut at the camera plane (Sutherland–Hodgman) so it stays whole with the camera inside it
function groundCircle(x, y, r) {
  ctx.beginPath();
  const h = ringPts(x, y, r).map(p => Ph(p[0], p[1]));
  for (let i = 1; i < h.length; i++) {
    const s = clipNear(h[i - 1], h[i]);
    if (s) { ctx.lineTo(s[0], s[1]); if (s[5]) ctx.lineTo(s[2], s[3]); }
  }
}
function offsetPolyline(pts, d) {
  if (!d) return pts;
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
    if (i > 0) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; n1x = -(b[1] - a[1]) / L; n1y = (b[0] - a[0]) / L; }
    if (i < n - 1) { const L = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1; n2x = -(c[1] - b[1]) / L; n2y = (c[0] - b[0]) / L; }
    if (i === 0) { n1x = n2x; n1y = n2y; }
    if (i === n - 1) { n2x = n1x; n2y = n1y; }
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const cos = Math.max(0.5, mx * n1x + my * n1y);
    out.push([b[0] + mx * d / cos, b[1] + my * d / cos, b[2]]);
  }
  return out;
}

// routes sharing a track are drawn side by side
let trackRoutesCache = { v: -1, map: null };
function trackRoutes() {
  if (trackRoutesCache.v === G.version && trackRoutesCache.g === G) return trackRoutesCache.map;   // versions restart with each game
  const m = new Map();
  for (const r of G.routes) for (const leg of r.legs) for (const p of leg) {
    if (!m.has(p.t)) m.set(p.t, []);
    const l = m.get(p.t);
    if (!l.includes(r.id)) l.push(r.id);
  }
  trackRoutesCache = { v: G.version, g: G, map: m };
  return m;
}
// cached per route until the network or the side-by-side spacing changes (it was rebuilt every frame)
const routeGeomCache = new WeakMap();
function routeGeom(r, spacing) {
  const c = routeGeomCache.get(r);
  if (c && c.v === G.version && c.spacing === spacing) return c.geom;
  const tr = trackRoutes();
  const geom = r.legs.map(leg => {
    const pts = [];
    for (const p of leg) {
      const ids = tr.get(p.t), i = ids.indexOf(r.id);
      let seg = offsetPolyline(trackProfile(TR(p.t)).pts3, (i - (ids.length - 1) / 2) * spacing);   // follows ramps up and down
      if (p.rev) seg = seg.slice().reverse();
      for (let k = pts.length ? 1 : 0; k < seg.length; k++) pts.push(seg[k]);
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return { pts, cum };
  });
  routeGeomCache.set(r, { v: G.version, spacing, geom });
  return geom;
}
function pointAlong(g, frac) {
  const s = frac * g.cum[g.cum.length - 1];
  let k = 1;
  while (k < g.cum.length - 1 && g.cum[k] < s) k++;
  const a = g.pts[k - 1], b = g.pts[k], seg = g.cum[k] - g.cum[k - 1] || 1, u = (s - g.cum[k - 1]) / seg;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.atan2(b[1] - a[1], b[0] - a[0]), (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * u];
}
// where is train i of route r right now? -> [x, y, angle] in world space
function trainPos(r, geom, i, tSec) {
  let t = ((tSec + i * r.cycle / r.trains) % r.cycle + r.cycle) % r.cycle;
  const back = t >= r.half;
  if (back) t -= r.half;
  const L = r.legs.length;
  for (let j = 0; j < L; j++) {
    const k = back ? L - 1 - j : j;
    if (t < DWELL) return pointAlong(geom[k], back ? 1 : 0);
    t -= DWELL;
    if (t < r.legTime[k]) {
      const u = t / r.legTime[k], e = u * u * (3 - 2 * u);
      return pointAlong(geom[k], back ? 1 - e : e);
    }
    t -= r.legTime[k];
  }
  return pointAlong(geom[back ? 0 : L - 1], back ? 0 : 1);
}

function loadColor(c) {
  if (c < 0.5) return '#2fbf71';
  if (c < 0.8) return '#e6c229';
  if (c < 1) return '#f08a24';
  return '#e0302b';
}
function label(text, x, y, size, color = '#111', halo = 'rgba(255,255,255,0.9)', weight = 600) {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

const TRACK_STYLE = {
  elevated: { c: '#3d3d3d', w: 5, inner: '#b8b8b8' },
  atgrade: { c: '#7b6a4f', w: 4 },
  cutcover: { c: '#5d6470', w: 3.5, dash: [9, 4] },
  deep: { c: '#2f3440', w: 3.5, dash: [3, 4] },
};
// One stroke per track: batching them all into one path rasterized slower in Chrome, not faster.
function strokeTrack(pts, type) {
  const s = TRACK_STYLE[type];
  ctx.setLineDash(s.dash || []);
  pathPts(pts, altOf(type));
  ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.stroke();
  if (s.inner) { ctx.strokeStyle = s.inner; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.setLineDash([]);
}
const onScreen = (px, py, m = 40) => px > -m && py > -m && px < CW + m && py < CH + m;

// The overlay is redrawn by the map's render event (in step with the camera) and otherwise only when something
// changed: input (needsDraw, set by the listeners in ui.js), the network, sim results, or trains moving.
let needsDraw = true, drawn = null;
const overlayStale = () => needsDraw || !drawn || drawn[0] !== G || drawn[1] !== G.version || drawn[2] !== G.res || (G.routes.length > 0 && drawn[3] !== G.minute);
function draw() {
  needsDraw = false; drawn = [G, G.version, G.res, G.minute];
  ctx.clearRect(0, 0, CW, CH);
  if (!map) return;
  pruneUI();
  const C = G.city, z = pxPerM();
  updateViaduct();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // study-area boundary
  ctx.setLineDash([10, 6]); ctx.strokeStyle = 'rgba(30,40,60,0.55)'; ctx.lineWidth = 1.5;
  pathPts([[0, 0], [C.W, 0], [C.W, C.H], [0, C.H], [0, 0]]); ctx.stroke(); ctx.setLineDash([]);

  // airports
  for (const a of C.airports) {
    const [px, py] = P(a.x, a.y);
    if (onScreen(px, py)) label('✈ ' + a.name, px, py - 18, 12, '#334', 'rgba(255,255,255,0.85)', 700);
  }

  // commute demand desire lines
  if (UI.overlay === 'demand' && G.res) {
    const max = G.res.flows.length ? G.res.flows[0].n : 1;
    for (const f of G.res.flows) {
      const s = Math.min(1, f.t / f.n * 3);
      ctx.strokeStyle = `rgba(${Math.round(150 - 120 * s)},${Math.round(90 + 110 * s)},${Math.round(200 - 120 * s)},0.6)`;
      ctx.lineWidth = 1 + 10 * f.n / max;
      pathPts([[f.x1, f.y1], [f.x2, f.y2]]); ctx.stroke();
    }
  }

  const tr = trackRoutes();
  const ridership = UI.overlay === 'ridership';
  for (const t of G.tracks) {
    if (!tr.has(t.id)) strokeTrack(trackProfile(t).pts3, t.type);   // a route line covers its track; drawing both cost ~40% of the overlay
    if (t.planned) { ctx.setLineDash([7, 5]); pathPts(trackProfile(t).pts3); ctx.strokeStyle = PLAN_BLUE; ctx.lineWidth = 3.5; ctx.stroke(); ctx.setLineDash([]); }
  }

  // routes
  const lw = Math.max(3, Math.min(8, z * 55)), spacing = +((lw + 1) / z).toPrecision(2);   // rounded so route geometry stays cached while zooming a little
  const geoms = new Map();
  const maxFlow = Math.max(1, ...G.routes.flatMap(r => r.legFlow || [0]));
  for (const r of G.routes) {
    const geom = routeGeom(r, spacing);
    geoms.set(r.id, geom);
    ctx.globalAlpha = UI.sel && UI.sel.kind === 'route' && UI.sel.id !== r.id ? 0.25 : 1;
    geom.forEach((g, k) => {
      pathPts(g.pts);
      if (ridership) {
        ctx.strokeStyle = loadColor(r.load ? r.load[k] : 0);
        ctx.lineWidth = lw * 0.6 + 14 * Math.sqrt((r.legFlow ? r.legFlow[k] : 0) / maxFlow);
      } else { ctx.strokeStyle = r.color; ctx.lineWidth = lw; }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // junctions (track switches) and free track ends
  for (const j of G.nodes) {
    const [px, py] = P(j.x, j.y, nodeAlt(j));
    if (!onScreen(px, py)) continue;
    const hov = UI.hover && UI.hover.id === j.id, sel = UI.sel && UI.sel.id === j.id;
    const col = (UI.tool === 'demolish' && hov) ? '#e0302b' : sel ? '#2050d0' : j.planned ? PLAN_BLUE : '#222';
    if (j.end) {   // a track end; the joint between two pieces only shows while drawing track
      if (UI.tool !== 'track' && !hov && G.tracks.filter(t => t.a === j.id || t.b === j.id).length > 1) continue;
      ctx.beginPath(); ctx.arc(px, py, hov || sel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      continue;
    }
    ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = col;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    const r = hov || sel ? 6 : 4.5;
    ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.strokeRect(-r, -r, 2 * r, 2 * r);
    ctx.restore();
  }
  // control points of existing track (drag to reshape)
  for (const t of handleTracks()) (t.ctrl || []).forEach((c, i) => {
    if (UI.drag && UI.drag.t === t.id) return;
    if (onScreen(...P(c[0], c[1]))) drawHandle(c[0], c[1], altOf(t.type), false);
  });

  // selected station: walk catchment + where its riders go
  if (UI.sel && UI.sel.kind === 'station') {
    const s = ST(UI.sel.id);
    if (s) {
      groundCircle(s.x, s.y, ACCESS_R);
      ctx.fillStyle = 'rgba(40,80,200,0.08)'; ctx.fill();
      ctx.setLineDash([6, 5]); pathPts(ringPts(s.x, s.y, ACCESS_R)); ctx.strokeStyle = 'rgba(40,80,200,0.75)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      const dest = stationDestinations(s.id);
      const max = dest.length ? dest[0][1] : 1;
      for (const [id, n] of dest.slice(0, 25)) {
        const d = ST(id);
        ctx.strokeStyle = 'rgba(160,40,200,0.6)'; ctx.lineWidth = 1 + 8 * n / max;
        const mx = (s.x + d.x) / 2 - (d.y - s.y) * 0.25, my = (s.y + d.y) / 2 + (d.x - s.x) * 0.25, arc = [];
        for (let k = 0; k <= 16; k++) { const u = k / 16; arc.push([(1 - u) ** 2 * s.x + 2 * u * (1 - u) * mx + u * u * d.x, (1 - u) ** 2 * s.y + 2 * u * (1 - u) * my + u * u * d.y]); }
        pathPts(arc); ctx.stroke();
      }
    }
  }

  // trains
  const tSec = G.minute * 60;
  for (const r of G.routes) {
    const geom = geoms.get(r.id), half = r.cars * 10;
    for (let i = 0; i < r.trains; i++) {
      const [x, y, a, al] = trainPos(r, geom, i, tSec);
      const [px, py] = P(x, y, al);
      if (!onScreen(px, py)) continue;
      const [fx, fy] = P(x + Math.cos(a) * half, y + Math.sin(a) * half, al), [bx, by] = P(x - Math.cos(a) * half, y - Math.sin(a) * half, al);
      const len = Math.hypot(fx - bx, fy - by), ext = len < 8 ? (8 - len) / 2 / (len || 1) : 0;
      ctx.beginPath();
      ctx.moveTo(bx - (fx - bx) * ext, by - (fy - by) * ext); ctx.lineTo(fx + (fx - bx) * ext, fy + (fy - by) * ext);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#111'; ctx.lineWidth = lw + 4; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = lw + 1; ctx.stroke();
      ctx.lineCap = 'round';
    }
  }

  // transfer complexes: stairs/lifts between levels, passages between offset platforms
  const hub = new Map();
  for (const s of G.stations) if (s.complex && !hub.has(s.complex)) hub.set(s.complex, s);
  for (const s of G.stations) {
    const h = s.complex && hub.get(s.complex);
    if (!h || h === s) continue;
    const [ax, ay] = P(h.x, h.y, altOf(h.type)), [bx, by] = P(s.x, s.y, altOf(s.type));
    if (!onScreen(ax, ay, 100) && !onScreen(bx, by, 100)) continue;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineCap = 'round'; ctx.strokeStyle = '#111'; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = s.planned || h.planned ? 'rgba(170,195,245,0.95)' : '#fff'; ctx.lineWidth = 4; ctx.stroke();
  }

  // stations
  const use = G.res ? G.res.stationUse : new Map();
  const maxUse = Math.max(1, ...use.values());
  const served = new Set(G.routes.flatMap(r => r.stops));
  const showNames = map.getZoom() > 13.6;
  for (const s of G.stations) {
    const [px, py] = P(s.x, s.y, altOf(s.type));
    if (!onScreen(px, py, 80)) continue;
    const nr = G.routes.filter(r => r.stops.includes(s.id)).length;
    let rad = Math.max(3.5, Math.min(9, z * 70)) + (nr > 1 ? 1.5 : 0);
    if (ridership) rad += 14 * Math.sqrt((use.get(s.id) || 0) / maxUse);
    const isSel = UI.sel && UI.sel.kind === 'station' && UI.sel.id === s.id;
    const hov = UI.hover && UI.hover.kind === 'station' && UI.hover.id === s.id;
    // drawn as its platform when zoomed in enough, else as a dot
    let [e1, e2] = stationEnds(s);
    if (Math.hypot(e2[0] - e1[0], e2[1] - e1[1]) < rad * 1.5) { e1 = [px, py]; e2 = [px + 0.01, py]; }
    const olw = isSel || hov ? 3 : nr > 1 ? 2.5 : 1.8;
    ctx.beginPath(); ctx.moveTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]);
    ctx.strokeStyle = (UI.tool === 'demolish' && hov) ? '#e0302b' : isSel ? '#2050d0' : s.planned ? PLAN_BLUE : '#111';
    ctx.lineWidth = 2 * rad + 2 * olw; ctx.stroke();
    ctx.strokeStyle = s.planned ? 'rgba(170,195,245,0.95)' : served.has(s.id) ? '#fff' : '#d4d4d4';
    ctx.lineWidth = 2 * rad; ctx.stroke();
    const sameAsHub = s.complex && hub.get(s.complex) !== s && hub.get(s.complex).name === s.name;   // one label per complex
    if ((showNames && !sameAsHub) || isSel || hov) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      label(s.name, px + rad + 2, py - rad - 2, 12);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    }
  }

  drawToolPreview(lw);
  syncDemolition();
}

function stationDestinations(id) {
  const m = new Map();
  for (const g of G.city.groups) {
    if (!g.pt || g.pt < 0.01) continue;
    if (g.o === id) m.set(g.d, (m.get(g.d) || 0) + g.size * g.pt);
    else if (g.d === id) m.set(g.o, (m.get(g.o) || 0) + g.size * g.pt);
  }
  return [...m.entries()].filter(([k]) => ST(k)).sort((a, b) => b[1] - a[1]);
}

function costTag(text, px, py, bad) {
  ctx.font = '600 12px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = bad ? 'rgba(200,40,40,0.92)' : 'rgba(20,24,31,0.9)';
  ctx.beginPath(); ctx.roundRect(px + 14, py + 10, w, 22, 5); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(text, px + 20, py + 21); ctx.textAlign = 'center';
}

// ---------- demolition highlight: OSM building ids aren't unique (multipolygons share one id across many
// footprints), so the buildings are found by the points that hit them and redrawn red at the same height and opacity
const DEMO_RED = '#e0302b';
let previewDemo = null, demoKey = '';
function inflate(rings) {   // grow a footprint ~0.5 m so its red walls sit just outside the original's
  return rings.map(r => {
    let cx = 0, cy = 0;
    for (const [a, b] of r) { cx += a; cy += b; }
    cx /= r.length; cy /= r.length;
    const kx = 111320 * Math.cos(cy * Math.PI / 180), rad = Math.max(5, ...r.map(([a, b]) => Math.hypot((a - cx) * kx, (b - cy) * 110540))), f = 1 + 0.5 / rad;
    return r.map(([a, b]) => [cx + (a - cx) * f, cy + (b - cy) * f]);
  });
}
function syncDemolition() {
  if (!mapReady || !map.getSource('demo-bld')) return;
  const pts = [...(previewDemo || [])];
  for (const o of [...G.tracks, ...G.stations]) if (o.planned) pts.push(...(o.demoPts || []));
  const key = pts.map(p => Math.round(p[0]) + ',' + Math.round(p[1])).join(';');
  if (key === demoKey) return;
  demoKey = key;
  const seen = new Set(), features = [];
  for (const [x, y] of pts) {
    const b = buildingAt(x, y);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    features.push({ type: 'Feature', properties: { h: b.h + 0.5 }, geometry: { type: 'Polygon', coordinates: inflate(b.rings) } });
  }
  map.getSource('demo-bld').setData({ type: 'FeatureCollection', features });
}

function drawToolPreview(lw) {
  previewDemo = null;
  const m = UI.mouse;
  if (!m.in) return;
  const [mx, my] = Wpt(m.x, m.y);
  const hovStation = UI.hover && UI.hover.kind === 'station';
  const hovNode = UI.hover && (UI.hover.kind === 'station' || UI.hover.kind === 'junction');
  const hovTrack = UI.hover && UI.hover.kind === 'track' ? TR(UI.hover.id) : null;
  const snap = hovTrack && nearestOnTrack(hovTrack, mx, my);
  if ((UI.tool === 'track' || UI.tool === 'station') && snap) {   // where a branch / inserted station would attach
    const [sx2, sy2] = P(snap.x, snap.y);
    ctx.beginPath(); ctx.arc(sx2, sy2, 7, 0, Math.PI * 2); ctx.strokeStyle = '#2050d0'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  if (UI.tool === 'station' && (UI.stationAt || (!hovStation && !snap))) {
    const [cx, cy] = UI.stationAt || [mx, my];
    const ang = UI.stationAt && Math.hypot(mx - cx, my - cy) > 5 ? Math.atan2(my - cy, mx - cx) : 0;
    const base = UI.transferOf && ST(UI.transferOf);
    const r = throttled(stationPreview, `${UI.build}|${Math.round(cx)},${Math.round(cy)}|${ang.toFixed(2)}|${UI.transferOf}`, () => {
      const c = stationCost(cx, cy, UI.build, ang), clash = base && transferClash(base, UI.build, ang);
      return clash ? { err: `Runs into the ${TYPES[UI.build].label.toLowerCase()} platform — ↑/↓ for another level, or turn it` } : c;
    });    previewDemo = r.demoPts;

    ctx.setLineDash([5, 5]); pathPts(ringPts(cx, cy, ACCESS_R));
    ctx.strokeStyle = 'rgba(40,80,200,0.45)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    const [e1, e2] = stationEnds({ x: cx, y: cy }, ang, UI.build);   // at its level: a transfer platform floats above / sits below the other
    ctx.beginPath(); ctx.moveTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = r.err ? '#e0302b' : PLAN_BLUE; ctx.lineWidth = 16; ctx.globalAlpha = UI.stationAt ? 0.9 : 0.5; ctx.stroke();
    ctx.strokeStyle = r.err ? 'rgba(255,200,200,0.9)' : 'rgba(255,255,255,0.9)'; ctx.lineWidth = 11; ctx.stroke(); ctx.globalAlpha = 1;
    if (UI.stationAt) { const [qx, qy] = P(cx, cy); ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(m.x, m.y); ctx.setLineDash([4, 4]); ctx.strokeStyle = PLAN_BLUE; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); }
    costTag(r.err || `${base ? `${TYPES[UI.build].label} transfer platform at ${base.name}` : `${TYPES[UI.build].label} station`} · ${fmtMoney(r.cost)}${r.demolished ? ` · demolishes ${r.demolished} bldg` : ''} · ${UI.stationAt ? 'click to place' : 'click to set centre'}`, m.x, m.y, !!r.err);
  }
  if (UI.drag) {   // reshaping an existing track
    const t = TR(UI.drag.t);
    const g = throttled(geomPreview, 'drag' + UI.drag.ctrl.flat().map(Math.round).join(','), () => trackGeometry(ST(t.a), UI.drag.ctrl, ST(t.b), t.id));
    const r = g && g.pts ? throttled(costPreview, 'dragc' + g.pts.length + UI.drag.ctrl.flat().map(Math.round).join(','), () => trackCost(g.pts, t.type)) : {};
    previewDemo = r.demoPts;
    const err = (g && g.err) || r.err;
    pathPts(g && g.pts ? g.pts : [[ST(t.a).x, ST(t.a).y], ...UI.drag.ctrl, [ST(t.b).x, ST(t.b).y]], altOf(t.type));
    ctx.strokeStyle = err ? '#e0302b' : '#2050d0'; ctx.lineWidth = 4; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
    UI.drag.ctrl.forEach((c, i) => drawHandle(c[0], c[1], altOf(t.type), i === UI.drag.i));
    const extra = (r.cost || 0) - (trackCost(t.pts, t.type).cost || 0);
    costTag(err || `${(r.len / 1000).toFixed(2)} km · ${extra > 0 ? '+' + fmtMoney(extra) : 'no extra cost'}`, m.x, m.y, !!err);
    return;
  }
  if (UI.tool === 'track' && UI.from) {
    const A = fromNode(), e = endTarget(UI.hover, mx, my), B = targetNode(e);
    const d = draftCtrl(A, [B.x, B.y], m.shift, true);
    const key = [A.x, A.y, B.x, B.y, UI.shape, UI.build, ...d.ctrl.flat()].map(v => typeof v === 'number' ? Math.round(v) : v).join(',');
    const g = throttled(geomPreview, key, () => trackGeometry(A, d.ctrl, B));
    const r = g && g.pts ? throttled(costPreview, key, () => trackCost(g.pts, UI.build)) : {};
    previewDemo = r.demoPts;
    const err = d.err || (g && g.err) || r.err, cost = (r.cost || 0) + (e.track ? JUNCTION_COST : 0) + (UI.from.track ? JUNCTION_COST : 0);
    pathPts(g && g.pts ? g.pts : [[A.x, A.y], ...d.ctrl, [B.x, B.y]]);
    ctx.strokeStyle = err ? '#e0302b' : '#2050d0'; ctx.lineWidth = 4; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
    for (const c of UI.ctrl) drawHandle(c[0], c[1], 0, false);
    if (UI.curveCtrl) {   // curve handle: start → bend point → end
      const [qx, qy] = P(UI.curveCtrl[0], UI.curveCtrl[1]), [ax2, ay2] = P(A.x, A.y);
      ctx.beginPath(); ctx.moveTo(ax2, ay2); ctx.lineTo(qx, qy); ctx.lineTo(m.x, m.y);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(32,80,208,0.6)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      drawHandle(UI.curveCtrl[0], UI.curveCtrl[1], 0, true);
    }
    const tag = UI.shape === 'curve' && !UI.curveCtrl ? 'Click the curve’s bend point'
      : `${((r.len || 0) / 1000).toFixed(2)} km ${TYPES[UI.build].label}${e.track ? ' + junction' : ''} · ${fmtMoney(cost)}${r.demolished ? ` · demolishes ${r.demolished} bldg` : ''}`;
    costTag(err || tag, m.x, m.y, !!err);
  }
  if (UI.tool === 'route' && UI.routeDraft) {
    const d = UI.routeDraft;
    ctx.strokeStyle = d.color; ctx.lineWidth = lw + 3; ctx.globalAlpha = 0.85;
    for (const leg of d.legs) { pathPts(legPoints(leg)); ctx.stroke(); }
    ctx.globalAlpha = 1;
    d.stops.forEach((id, k) => {
      const [px, py] = P(ST(id).x, ST(id).y);
      ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.fillStyle = d.color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui'; ctx.fillText(k + 1, px, py + 0.5);
    });
    if (hovStation && d.stops.length) {
      const last = d.legs.length ? d.legs[d.legs.length - 1].at(-1) : null;
      const p = trackPath(d.stops[d.stops.length - 1], UI.hover.id, last ? trackDir(TR(last.t), last.rev, true) : null);
      if (p) { ctx.setLineDash([6, 5]); ctx.strokeStyle = d.color; ctx.lineWidth = lw; pathPts(legPoints(p)); ctx.stroke(); ctx.setLineDash([]); }
      else if (UI.hover.id !== d.stops[d.stops.length - 1]) costTag('No path without reversing', m.x, m.y, true);
    }
  }
  if (UI.tool === 'demolish' && UI.hover && UI.hover.kind === 'track') {
    const t = TR(UI.hover.id);
    if (t) { pathPts(t.pts); ctx.strokeStyle = '#e0302b'; ctx.lineWidth = 7; ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1; }
  }
}
