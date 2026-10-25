'use strict';
// Real-city demand model built from US Census data (see tools/build_data.py).
// World coordinates are metres from the study area's north-west corner, y pointing south.

const CELL = 400;   // demand grid cell size, m

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function loadCityData(id) {
  return new Promise((ok, fail) => {
    if (window.CITY_DATA && CITY_DATA[id]) return ok(CITY_DATA[id]);
    const s = document.createElement('script');
    s.src = `data/${id}.js`;
    s.onload = () => CITY_DATA && CITY_DATA[id] ? ok(CITY_DATA[id]) : fail(new Error('bad data file'));
    s.onerror = () => fail(new Error(`data/${id}.js missing — run tools/build_data.py`));
    document.head.appendChild(s);
  });
}

function buildCity(d) {
  const [west, south, east, north] = d.bbox;
  const kx = 111320 * Math.cos((south + north) / 2 * Math.PI / 180), ky = 110540;
  const C = {
    id: d.id, name: d.name, W: (east - west) * kx, H: (north - south) * ky,
    toXY: (lon, lat) => [(lon - west) * kx, (north - lat) * ky],
    toLngLat: (x, y) => [west + x / kx, north - y / ky],
  };
  C.GW = Math.ceil(C.W / CELL); C.GH = Math.ceil(C.H / CELL);
  const N = C.GW * C.GH;
  C.cellAt = (x, y) => Math.min(C.GH - 1, Math.max(0, Math.floor(y / CELL))) * C.GW + Math.min(C.GW - 1, Math.max(0, Math.floor(x / CELL)));
  C.inside = (x, y) => x >= 0 && y >= 0 && x <= C.W && y <= C.H;

  // block groups -> grid
  const bg = [];
  const pop = new Float32Array(N), jobs = new Float32Array(N);
  for (let i = 0; i < d.bgs.length; i += 4) {
    const [x, y] = C.toXY(d.bgs[i], d.bgs[i + 1]);
    bg.push({ x, y, lon: d.bgs[i], lat: d.bgs[i + 1], pop: d.bgs[i + 2], jobs: d.bgs[i + 3] });
    const c = C.cellAt(x, y);
    pop[c] += d.bgs[i + 2]; jobs[c] += d.bgs[i + 3];
  }
  C.bgs = bg;
  const pct = (arr, q) => { const s = Array.from(arr).filter(v => v > 0).sort((a, b) => a - b); return s[Math.floor(s.length * q)] || 1; };
  const pN = pct(pop, 0.97), jN = pct(jobs, 0.97);
  const comb = pop.map((v, i) => v + jobs[i]), cN = pct(comb, 0.95);
  C.pop = pop; C.jobs = jobs;
  C.popN = pop.map(v => Math.min(1, v / pN));
  C.jobN = jobs.map(v => Math.min(1, v / jN));
  C.dens = comb.map(v => Math.min(1, v / cN));
  C.densAt = (x, y) => C.dens[C.cellAt(x, y)];
  C.totalPop = d.residents; C.totalJobs = d.commuters;
  let best = 0;
  for (let c = 1; c < N; c++) if (jobs[c] > jobs[best]) best = c;
  C.cbd = [(best % C.GW + 0.5) * CELL, (Math.floor(best / C.GW) + 0.5) * CELL];

  C.airports = d.airports.map(a => { const [x, y] = C.toXY(a.lon, a.lat); return { name: a.name, x, y }; });
  C.airportAt = (x, y) => C.airports.find(a => Math.hypot(a.x - x, a.y - y) < 1200);

  // commuter groups: block-group centroid plus a little deterministic spread
  const rand = mulberry32(7);
  const jit = (b) => { const r = 300 * Math.sqrt(rand()), a = rand() * 6.2832; return [b.x + Math.cos(a) * r, b.y + Math.sin(a) * r]; };
  C.groups = [];
  for (let i = 0; i < d.groups.length; i += 3) {
    const h = bg[d.groups[i]], w = bg[d.groups[i + 1]];
    const [hx, hy] = jit(h), [wx, wy] = jit(w);
    C.groups.push({ hx, hy, wx, wy, hc: C.cellAt(h.x, h.y), wc: C.cellAt(w.x, w.y), size: d.unit * d.groups[i + 2], dist: Math.hypot(wx - hx, wy - hy) });
  }
  // filled in by the map once tiles load
  C.waterAt = () => 0;
  C.buildingAt = () => null;
  C.nameAt = (x, y, taken) => { let n = 1; while (taken.has('Station ' + n)) n++; return 'Station ' + n; };
  return C;
}
