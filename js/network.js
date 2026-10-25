'use strict';
// Game state + network construction: stations, tracks, routes, trains.

// water: cost multiplier over water (0 = impossible); demo: must demolish buildings in its path
const TYPES = {
  elevated: { label: 'Elevated', key: 'Z', km: 32e6, station: 18e6, dens: 0.3, water: 4, demo: true, desc: 'Viaduct on piers. Bridges water at 4× cost. Demolishes buildings in its path.' },
  atgrade: { label: 'At-Grade', key: 'X', km: 12e6, station: 8e6, dens: 0.6, water: 0, demo: true, desc: 'Cheapest. Cannot cross water. Demolishes buildings in its path.' },
  cutcover: { label: 'Cut & Cover', key: 'C', km: 55e6, station: 32e6, dens: 0.5, water: 6, demo: true, desc: 'Shallow trench. Under water it becomes an immersed tube at 6× cost. Demolishes buildings.' },
  deep: { label: 'Deep Bore', key: 'V', km: 95e6, station: 65e6, dens: 0.1, water: 3, demo: false, desc: 'Bored tunnel: passes under buildings, 3× cost under water.' },
};
const DEMO_BASE = 4e6, DEMO_FLOOR = 1.5e6, FLOOR_H = 3.5;   // $ per building, $ per storey, m per storey
const demolitionCost = h => DEMO_BASE + DEMO_FLOOR * Math.max(1, Math.round((h || 6) / FLOOR_H));
const VMAX = 22.2, ACC = 1.0, DWELL = 30, TURNAROUND = 120;   // m/s, m/s², s, s
const CAR_CAP = 140, CAR_COST = 2.5e6, CAR_HOUR = 70;          // riders/car, $/car, $/car-hour
const MIN_HEADWAY = 90;                                         // s
const MAX_BEND = 75;                                           // safety limit on any single kink, degrees
const MAX_THROUGH = 110, JUNCTION_COST = 5e6;                  // sharpest turn through a node (more = reversing), degrees; switch cost
const START_MONEY = 3e9;
const LEVELS = ['deep', 'cutcover', 'atgrade', 'elevated'];       // construction types from lowest to highest
const TRANSFER_MIN = 1.5, TRANSFER_LEVEL = 1;                    // min to change platform in a complex, + per level climbed
const TRANSFER_LINK = 200;                                       // m: imported stations this close become one complex
const ROUTE_COLORS = ['#EE352E', '#0039A6', '#00933C', '#FF6319', '#B933AD', '#FCCC0A', '#996633', '#6CBE45',
  '#00ADD0', '#A7A9AC', '#D82233', '#1D2F6F', '#F6A01A', '#E86FB0'];
const ROUTE_NAMES = 'ABCDEFGJLMNQRSWZ1234567'.split('');

let G = null;

function newGame(data) {
  G = {
    cityId: data.id, city: buildCity(data), stations: [], nodes: [], tracks: [], routes: [], nextId: 1,
    money: START_MONEY, minute: 6 * 60, fare: 2.9, bonds: [], history: [], goals: {}, speed: 1,
    today: blankDay(), res: null, version: 0, sMap: new Map(), tMap: new Map(),
  };
  prepGroups();
  makeGoals();
  markDirty();
}
function blankDay() { return { fares: 0, ops: 0, maint: 0, construction: 0, interest: 0, trains: 0, rewards: 0 }; }
// G.sMap holds every track node: stations, junctions (switches) and free track ends — only stations are stops
function reindex() {
  G.sMap = new Map([...G.stations, ...G.nodes].map(s => [s.id, s]));
  G.tMap = new Map(G.tracks.map(t => [t.id, t]));
}
const ST = id => G.sMap.get(id);
const TR = id => G.tMap.get(id);
const isTrackNode = id => !!(ST(id) && (ST(id).junction || ST(id).end));

function spend(amount, kind) {
  if (amount > G.money) { toast(`Not enough money — need ${fmtMoney(amount)}`, true); return false; }
  G.money -= amount;
  G.today[kind] += amount;
  return true;
}

// ---------- costs & validation
const PLATFORMS = { short: 80, standard: 120, long: 180 };   // platform lengths, m (one car ≈ 20 m)
const PLATFORM = PLATFORMS.standard;
const plen = s => s.plen || PLATFORM;
const maxCarsAt = s => Math.floor(plen(s) / 20);
function stationCost(x, y, type, ang = 0, len = PLATFORM) {
  const C = G.city, t = TYPES[type];
  if (!C.inside(x, y)) return { err: 'Outside the census data area' };
  if (C.waterAt(x, y)) return { err: 'Cannot build a station on water' };
  const demo = new Map();   // buildings inside the oriented platform box (len × 16 m)
  if (t.demo) for (let u = -len / 2; u <= len / 2; u += 20) for (const v of [-6, 6]) {
    const b = C.buildingAt(x + Math.cos(ang) * u - Math.sin(ang) * v, y + Math.sin(ang) * u + Math.cos(ang) * v);
    if (b) demo.set(b.id, { h: b.h, x: x + Math.cos(ang) * u - Math.sin(ang) * v, y: y + Math.sin(ang) * u + Math.cos(ang) * v });
  }
  const demoCost = [...demo.values()].reduce((s, d) => s + demolitionCost(d.h), 0);
  return { cost: t.station * len / PLATFORM * (1 + t.dens * C.densAt(x, y)) + demoCost, demolished: demo.size, demoCost, demoPts: [...demo.values()].map(d => [d.x, d.y]) };
}

function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
function bendAngle(a, b, c) {
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d * 180 / Math.PI;
}

function trackCost(pts, type) {
  const C = G.city, t = TYPES[type];
  let cost = 0, water = false;
  const demo = new Map();
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / 25));
    for (let k = 0; k < n; k++) {
      const x = ax + (bx - ax) * (k + 0.5) / n, y = ay + (by - ay) * (k + 0.5) / n;
      const w = C.waterAt(x, y);
      if (w) water = true;
      else if (t.demo) { const b = C.buildingAt(x, y); if (b) demo.set(b.id, { h: b.h, x, y }); }
      cost += t.km * (L / n) / 1000 * (w ? t.water : 1 + t.dens * C.densAt(x, y));
    }
  }
  const len = polyLen(pts);
  if (water && !t.water) return { len, err: `${t.label} track cannot cross water — use Elevated (bridge), Cut & Cover (immersed tube) or Deep Bore` };
  const demoCost = [...demo.values()].reduce((s, d) => s + demolitionCost(d.h), 0);
  cost += demoCost;
  for (let i = 1; i < pts.length - 1; i++)
    if (bendAngle(pts[i - 1], pts[i], pts[i + 1]) > MAX_BEND) return { len, err: 'Curve too sharp' };
  if (pts.some(p => !C.inside(p[0], p[1]))) return { len, err: 'Outside the census data area' };
  return { cost, len, demolished: demo.size, demoCost, water, demoPts: [...demo.values()].map(d => [d.x, d.y]) };
}
const demoNote = r => r.demolished ? ` — demolishes ${r.demolished} building${r.demolished > 1 ? 's' : ''} (${fmtMoney(r.demoCost)})` : '';

function simplifyPath(pts, tol) {
  if (pts.length < 3) return pts;
  let best = -1, bd = tol;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]); if (d > bd) { bd = d; best = i; } }
  if (best < 0) return [a, b];
  return [...simplifyPath(pts.slice(0, best + 1), tol).slice(0, -1), ...simplifyPath(pts.slice(best), tol)];
}

// ---------- track geometry
// A track is two end nodes plus control points [x, y, radius]. Every corner becomes a circular arc of at least
// MIN_RADIUS, and track leaves a node straight: along a station's platform, along the parent track at a junction,
// or straight on from the track already at a free end. The only spacing limits are these rules plus minimum length.
const MIN_RADIUS = 60, CTRL_R = 120;   // tightest allowed curve, default curve at a control point, m
const clearOf = n => n.junction ? 30 : n.end ? 0 : plen(n) / 2;          // straight track the node itself occupies
const leadOf = n => n.junction ? 60 : n.end ? 80 : plen(n) / 2 + 120;    // straight run out of the node before a curve
function nodeAxis(n, skip) {
  if (!n.end) return n.ang === undefined ? null : { ang: n.ang, both: true };
  const t = G.tracks.find(t => t.id !== skip && (t.a === n.id || t.b === n.id));
  return t ? { ang: trackDir(t, t.a === n.id, true), both: false } : null;
}
function trackGeometry(A, ctrl, B, skip) {
  const C = ctrl.map(c => [c[0], c[1], c[2] ?? CTRL_R]);
  const lead = (n, to) => {
    const ax = nodeAxis(n, skip);
    if (!ax) return null;
    let a = ax.ang;
    if (ax.both && Math.cos(a - Math.atan2(to[1] - n.y, to[0] - n.x)) < 0) a += Math.PI;
    const L = Math.min(leadOf(n), Math.max(clearOf(n) + 5, Math.hypot(to[0] - n.x, to[1] - n.y) / 2));
    return [n.x + Math.cos(a) * L, n.y + Math.sin(a) * L, Infinity];
  };
  const la = lead(A, C.length ? C[0] : [B.x, B.y]), lb = lead(B, C.length ? C[C.length - 1] : [A.x, A.y]);
  const poly = [[A.x, A.y], ...(la ? [la] : []), ...C, ...(lb ? [lb] : []), [B.x, B.y]];
  const need = clearOf(A) + clearOf(B) + 20;
  if (polyLen(poly) < need) return { err: `Track too short — needs at least ${Math.round(need)} m here` };
  const out = [poly[0]], n = poly.length;
  for (let i = 1; i < n - 1; i++) {
    const a = poly[i - 1], v = poly[i], c = poly[i + 1], th = bendAngle(a, v, c);
    if (th < 0.5) { out.push([v[0], v[1]]); continue; }
    if (th > 170) return { err: 'Track doubles back on itself — move the control points' };
    const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]), l2 = Math.hypot(c[0] - v[0], c[1] - v[1]);
    const av1 = i === 1 ? l1 - clearOf(A) : l1 / 2, av2 = i === n - 2 ? l2 - clearOf(B) : l2 / 2;
    const tn = Math.tan(th * Math.PI / 360), d = Math.min(av1, av2, v[2] * tn), R = d / tn;
    if (!(R >= MIN_RADIUS - 0.5)) return { err: `Curve too tight (${Math.max(0, Math.round(R))} m radius, minimum ${MIN_RADIUS} m) — give it more room` };
    // exact circular arc tangent to both legs
    const u1 = [(v[0] - a[0]) / l1, (v[1] - a[1]) / l1], u2 = [(c[0] - v[0]) / l2, (c[1] - v[1]) / l2];
    const side = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);
    const pin = [v[0] - u1[0] * d, v[1] - u1[1] * d], cx = pin[0] - u1[1] * side * R, cy = pin[1] + u1[0] * side * R;
    const a0 = Math.atan2(pin[1] - cy, pin[0] - cx), sweep = side * th * Math.PI / 180, k = Math.max(2, Math.ceil(th / 6));
    for (let j = 0; j <= k; j++) out.push([cx + Math.cos(a0 + sweep * j / k) * R, cy + Math.sin(a0 + sweep * j / k) * R]);
  }
  out.push(poly[n - 1]);
  const pts = out.filter((p, i) => !i || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 0.01).map(p => [p[0], p[1]]);
  return { pts };
}
// recompute every track meeting node n (after it turns or changes platform length); apply() commits
function regenTracksAt(n) {
  const out = [];
  for (const t of G.tracks.filter(t => t.a === n.id || t.b === n.id)) {
    const g = trackGeometry(ST(t.a), t.ctrl || [], ST(t.b), t.id);
    if (g.err) return { err: g.err };
    out.push([t, g.pts]);
  }
  return {
    apply() {
      for (const [t, pts] of out) { t.pts = pts; t.len = polyLen(pts); if (t.planned) t.cost = trackCost(pts, t.type).cost ?? t.cost; }
      G.routes.forEach(computeRoute); markDirty();
    },
  };
}

// ---------- plan mode: pieces are placed as a costed blueprint and only paid for on Build
const planning = () => typeof UI !== 'undefined' && UI.plan;
const builtStations = () => G.stations.filter(s => !s.planned);
const planItems = () => [...G.stations, ...G.nodes, ...G.tracks].filter(o => o.planned);
const planTotal = () => planItems().reduce((s, o) => s + (o.cost || 0), 0);
function commitPlan() {
  const items = planItems(), total = planTotal();
  if (!items.length) return false;
  if (!spend(total, 'construction')) return false;
  for (const o of items) { delete o.planned; delete o.cost; delete o.demoPts; }
  markDirty();
  toast(`Built ${items.length} planned piece${items.length > 1 ? 's' : ''} for ${fmtMoney(total)}`);
  return true;
}
function discardPlan() {
  G.tracks = G.tracks.filter(t => !t.planned);
  for (const n of [...G.stations, ...G.nodes]) if (n.planned) removePlannedNode(n);
  dropOrphanNodes();
  tidyComplexes();
  reindex(); markDirty();
}
// a planned station/junction may have split built track in two: join the halves back up
function removePlannedNode(n) {
  const ts = G.tracks.filter(t => t.a === n.id || t.b === n.id);
  if (ts.length === 2 && !ts[0].planned && !ts[1].planned) mergeAt(n, ts[0], ts[1]);
  else G.tracks = G.tracks.filter(t => t.a !== n.id && t.b !== n.id);
  G.stations = G.stations.filter(x => x !== n);
  G.nodes = G.nodes.filter(x => x !== n);
  reindex();
}
function mergeAt(n, t1, t2) {
  const a = t1.a === n.id ? t1.b : t1.a, b = t2.a === n.id ? t2.b : t2.a;
  const p1 = t1.b === n.id ? t1.pts : t1.pts.slice().reverse(), p2 = t2.a === n.id ? t2.pts : t2.pts.slice().reverse();
  const c1 = t1.b === n.id ? t1.ctrl || [] : (t1.ctrl || []).slice().reverse(), c2 = t2.a === n.id ? t2.ctrl || [] : (t2.ctrl || []).slice().reverse();
  const ctrl = [...c1, ...c2], g = trackGeometry(ST(a), ctrl, ST(b), t1.id);
  const pts = g.pts || [...p1, ...p2.slice(1)];
  const t = { id: G.nextId++, a, b, ctrl, pts, type: t1.type, len: polyLen(pts) };
  G.tracks.splice(G.tracks.indexOf(t1), 1, t);
  G.tracks = G.tracks.filter(x => x !== t2);
  for (const r of G.routes) {
    r.legs = r.legs.map(leg => {
      const out = [];
      for (let i = 0; i < leg.length; i++) {
        const q = leg[i], nx = leg[i + 1];
        if ((q.t === t1.id || q.t === t2.id) && nx && (nx.t === t1.id || nx.t === t2.id)) {
          const tq = q.t === t1.id ? t1 : t2, from = q.rev ? tq.b : tq.a;
          out.push({ t: t.id, rev: from !== a });
          i++;
        } else out.push(q);
      }
      return out;
    });
  }
  reindex();
  G.routes.forEach(computeRoute);
}

// ---------- construction
function buildStation(x, y, type, ang = 0, opts = {}) {
  const len = opts.plen || PLATFORM, r = stationCost(x, y, type, ang, len);
  if (r.err) { toast(r.err, true); return null; }
  const planned = planning();
  if (!planned && !spend(r.cost, 'construction')) return null;
  const taken = new Set(G.stations.map(s => s.name));
  let name = opts.name && (opts.sameName || !taken.has(opts.name)) ? opts.name : G.city.nameAt(x, y, taken);
  const s = { id: G.nextId++, x, y, type, ang, name };
  if (len !== PLATFORM) s.plen = len;
  if (planned) Object.assign(s, { planned: true, cost: r.cost });
  if (planned && r.demoPts.length) s.demoPts = r.demoPts;   // a point in each building it clears (shown red while planned)
  G.stations.push(s);
  reindex(); markDirty();
  if (!planned) toast(`Built ${s.name} (${fmtMoney(r.cost)})${demoNote(r)}`);
  return s;
}
// a bare track end (no station); free to place
function addEndNode(x, y) {
  const n = { id: G.nextId++, x, y, end: true };
  if (planning()) Object.assign(n, { planned: true, cost: 0 });
  G.nodes.push(n);
  reindex();
  return n;
}
// a free joint gaining a third track becomes a junction (a switch), lined up with the track already there
function toJunction(n) {
  if (!n.end || G.tracks.filter(t => t.a === n.id || t.b === n.id).length < 2) return true;
  const planned = planning() || !!n.planned;
  if (!planned && !spend(JUNCTION_COST, 'construction')) return false;
  const t = G.tracks.find(t => t.a === n.id || t.b === n.id);
  Object.assign(n, { junction: true, ang: trackDir(t, t.a === n.id, true) });
  delete n.end;
  if (planned) Object.assign(n, { planned: true, cost: (n.cost || 0) + JUNCTION_COST });
  return true;
}

function buildTrack(aId, bId, ctrl, type) {
  const a = ST(aId), b = ST(bId);
  if (aId === bId) return null;
  if (G.tracks.some(t => (t.a === aId && t.b === bId) || (t.a === bId && t.b === aId))) { toast('Those points are already connected', true); return null; }
  const g = trackGeometry(a, ctrl, b);
  if (g.err) { toast(g.err, true); return null; }
  const r = trackCost(g.pts, type);
  if (r.err) { toast(r.err, true); return null; }
  const planned = planning() || !!a.planned || !!b.planned;
  if (!planned && !spend(r.cost, 'construction')) return null;
  const t = { id: G.nextId++, a: aId, b: bId, ctrl: ctrl.map(c => [c[0], c[1], c[2] ?? CTRL_R]), pts: g.pts, type, len: r.len };
  if (planned) Object.assign(t, { planned: true, cost: r.cost });
  if (planned && r.demoPts.length) t.demoPts = r.demoPts;
  G.tracks.push(t);
  reindex(); markDirty();
  if (!planned) toast(`Built ${(r.len / 1000).toFixed(2)} km of ${TYPES[type].label.toLowerCase()} track (${fmtMoney(r.cost)})${demoNote(r)}`);
  return t;
}
// move, add or delete control points on an existing track
function editTrack(t, ctrl) {
  const g = trackGeometry(ST(t.a), ctrl, ST(t.b), t.id);
  if (g.err) { toast(g.err, true); return false; }
  const r = trackCost(g.pts, t.type);
  if (r.err) { toast(r.err, true); return false; }
  const extra = Math.max(0, r.cost - (trackCost(t.pts, t.type).cost || 0));
  if (!t.planned && extra && !spend(extra, 'construction')) return false;
  Object.assign(t, { ctrl, pts: g.pts, len: r.len, demoPts: r.demoPts });
  if (t.planned) t.cost = r.cost;
  for (const id of [t.a, t.b]) if (ST(id).end) { const re = regenTracksAt(ST(id)); if (!re.err) re.apply(); }   // keep neighbours tangent
  G.routes.forEach(computeRoute);
  markDirty();
  toast(t.planned ? 'Plan updated' : `Track realigned${extra ? ` (${fmtMoney(extra)})` : ''}`);
  return true;
}

// ---------- transfer complexes: platforms (often on different levels) joined by stairs and passages
const complexOf = s => s.complex ? G.stations.filter(o => o.complex === s.complex) : [s];
function linkStations(a, b) {
  if (a === b || (a.complex && a.complex === b.complex)) return;
  const id = a.complex || a.id, old = b.complex;
  for (const o of G.stations) if (o === b || (old && o.complex === old)) o.complex = id;
  a.complex = id;
  markDirty();
}
function tidyComplexes() {   // a complex left with one platform is just a station again
  const n = new Map();
  for (const o of G.stations) if (o.complex) n.set(o.complex, (n.get(o.complex) || 0) + 1);
  for (const o of G.stations) if (o.complex && n.get(o.complex) < 2) delete o.complex;
}
function platformEnds(s, ang = s.ang || 0, len = plen(s)) {
  const c = Math.cos(ang) * len / 2, si = Math.sin(ang) * len / 2;
  return [[s.x - c, s.y - si], [s.x + c, s.y + si]];
}
function segSegDist([a, b], [c, d]) {
  const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0) return 0;
  return Math.min(segDist(a[0], a[1], c[0], c[1], d[0], d[1]), segDist(b[0], b[1], c[0], c[1], d[0], d[1]),
    segDist(c[0], c[1], a[0], a[1], b[0], b[1]), segDist(d[0], d[1], a[0], a[1], b[0], b[1]));
}
// would a platform of this type/orientation at base's centre clash with a same-level platform already in the complex?
function transferClash(base, type, ang) {
  const mine = platformEnds({ x: base.x, y: base.y }, ang);
  return complexOf(base).find(o => o.type === type && segSegDist(mine, platformEnds(o)) < 15);
}
// add a platform on another level (or crossing at an angle) to an existing station, as one transfer complex
function buildTransfer(base, type, ang) {
  const clash = transferClash(base, type, ang);
  if (clash) { toast(`That platform would run into ${clash.name}’s ${TYPES[type].label.toLowerCase()} platform — pick another level (↑/↓) or turn it`, true); return null; }
  const s = buildStation(base.x, base.y, type, ang, { name: base.name, sameName: true });
  if (s) { linkStations(base, s); toast(`Added ${/^[aeiou]/i.test(TYPES[type].label) ? 'an' : 'a'} ${TYPES[type].label.toLowerCase()} transfer platform at ${base.name}`); }
  return s;
}
function linkNearby(s, r = 250) {
  const near = G.stations.filter(o => !complexOf(s).includes(o) && Math.hypot(o.x - s.x, o.y - s.y) < r);
  for (const o of near) linkStations(s, o);
  return near;
}

// ---------- station customisation
function renameStation(s, name) {   // renames every platform of a complex that shares the name
  name = (name || '').trim().slice(0, 60);
  const mine = complexOf(s).filter(o => o === s || o.name === s.name);
  if (!name || G.stations.some(o => !mine.includes(o) && o.name === name)) { if (name) toast('Another station already has that name', true); return; }
  for (const o of mine) o.name = name;
  G.version++;
}
// change construction type, platform length or orientation; attached track is re-curved and must still obey the rules
function restyleStation(s, changes) {
  const next = { ...s, ...changes };
  const oldCost = stationCost(s.x, s.y, s.type, s.ang || 0, plen(s)), nc = stationCost(next.x, next.y, next.type, next.ang || 0, plen(next));
  if (nc.err) { toast(nc.err, true); return false; }
  const saved = { type: s.type, plen: s.plen, ang: s.ang };
  Object.assign(s, changes);
  const re = regenTracksAt(s);
  if (re.err) { Object.assign(s, saved); toast(`Can’t: ${re.err}`, true); return false; }
  const used = G.routes.filter(r => r.stops.includes(s.id) && r.cars > maxCarsAt(s));
  if (used.length) { Object.assign(s, saved); toast(`Route ${used.map(r => r.name).join(', ')} runs trains too long for that platform — shorten them first`, true); return false; }
  const extra = Math.max(0, nc.cost - (oldCost.cost || 0));
  if (!s.planned && extra && !spend(extra, 'construction')) { Object.assign(s, saved); return false; }
  if (s.planned) s.cost = nc.cost;
  s.demoPts = nc.demoPts;
  re.apply();
  if (!s.planned && extra) toast(`${s.name} rebuilt (${fmtMoney(extra)})`);
  return true;
}

function routesUsingTrack(tid) { return G.routes.filter(r => r.legs.some(l => l.some(p => p.t === tid))); }
function routesUsingStation(sid) { return G.routes.filter(r => r.stops.includes(sid)); }

function demolishTrack(t) {
  const used = routesUsingTrack(t.id);
  if (used.length) { toast(`Track is used by route ${used.map(r => r.name).join(', ')} — edit or delete the route first`, true); return false; }
  G.tracks = G.tracks.filter(x => x !== t);
  dropOrphanNodes();
  reindex(); markDirty();
  toast(t.planned ? 'Removed from plan' : 'Track demolished');
  return true;
}
function dropOrphanNodes() {
  G.nodes = G.nodes.filter(j => G.tracks.some(t => t.a === j.id || t.b === j.id));
}
function demolishStation(s) {
  if (s.planned) { removePlannedNode(s); dropOrphanNodes(); tidyComplexes(); reindex(); markDirty(); return true; }
  const used = routesUsingStation(s.id).concat(...G.tracks.filter(t => t.a === s.id || t.b === s.id).map(t => routesUsingTrack(t.id)));
  if (used.length) { toast(`Station is used by route ${[...new Set(used.map(r => r.name))].join(', ')} — edit or delete the route first`, true); return false; }
  G.tracks = G.tracks.filter(t => t.a !== s.id && t.b !== s.id);
  G.stations = G.stations.filter(x => x !== s);
  G.nodes = G.nodes.filter(x => x !== s);
  dropOrphanNodes();
  tidyComplexes();
  reindex(); markDirty();
  toast(`${s.junction ? 'Junction' : s.end ? 'Track end' : s.name} demolished`);
  return true;
}

// ---------- branching: split a track at a point, inserting a junction (or a given station) there
function nearestOnTrack(t, x, y) {
  let best = { d: Infinity };
  for (let i = 1; i < t.pts.length; i++) {
    const [ax, ay] = t.pts[i - 1], [bx, by] = t.pts[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), px = ax + u * dx, py = ay + u * dy;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, i, x: px, y: py };
  }
  return best;
}
function alongTrack(t, x, y) {   // distance along the track to the point nearest (x, y)
  const p = nearestOnTrack(t, x, y);
  return polyLen(t.pts.slice(0, p.i)) + Math.hypot(p.x - t.pts[p.i - 1][0], p.y - t.pts[p.i - 1][1]);
}
// dry: only check whether the split would obey the track rules
function splitTrack(t, x, y, node, dry) {
  const p = nearestOnTrack(t, x, y);
  if (!node) for (const end of [t.a, t.b]) if (Math.hypot(ST(end).x - p.x, ST(end).y - p.y) < 40) return dry ? {} : ST(end);
  const [qa, qb] = [t.pts[p.i - 1], t.pts[p.i]], ang = Math.atan2(qb[1] - qa[1], qb[0] - qa[0]);
  const N = node || { id: -1, x: p.x, y: p.y, junction: true, ang };
  const s0 = alongTrack(t, p.x, p.y), ctrl = t.ctrl || [];
  const c1 = ctrl.filter(c => alongTrack(t, c[0], c[1]) < s0), c2 = ctrl.filter(c => alongTrack(t, c[0], c[1]) >= s0);
  const g1 = trackGeometry(ST(t.a), c1, N, t.id), g2 = trackGeometry(N, c2, ST(t.b), t.id), err = g1.err || g2.err;
  if (dry) return { err };
  if (err) { toast(err, true); return null; }
  if (!node) {
    if (G.city.waterAt(p.x, p.y) && !TYPES[t.type].water) { toast('Cannot place a junction on water', true); return null; }
    const planned = planning() || !!t.planned;
    if (!planned && !spend(JUNCTION_COST, 'construction')) return null;
    node = { ...N, id: G.nextId++ };
    if (planned) Object.assign(node, { planned: true, cost: JUNCTION_COST });
    G.nodes.push(node);
  }
  const t1 = { id: G.nextId++, a: t.a, b: node.id, ctrl: c1, pts: g1.pts, type: t.type, len: polyLen(g1.pts) };
  const t2 = { id: G.nextId++, a: node.id, b: t.b, ctrl: c2, pts: g2.pts, type: t.type, len: polyLen(g2.pts) };
  if (t.planned) for (const h of [t1, t2]) Object.assign(h, { planned: true, cost: t.cost * h.len / (t1.len + t2.len) });
  G.tracks.splice(G.tracks.indexOf(t), 1, t1, t2);
  reindex();
  for (const r of G.routes) {
    r.legs = r.legs.map(leg => leg.flatMap(q => q.t !== t.id ? [q] : q.rev ? [{ t: t2.id, rev: true }, { t: t1.id, rev: true }] : [{ t: t1.id, rev: false }, { t: t2.id, rev: false }]));
    computeRoute(r);
  }
  markDirty();
  return node;
}
function pointAtLength(t, s) {   // point and heading at distance s along the track
  for (let i = 1; i < t.pts.length; i++) {
    const [a, b] = [t.pts[i - 1], t.pts[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= L || i === t.pts.length - 1) { const u = Math.min(1, s / (L || 1)); return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) }; }
    s -= L;
  }
}
// place a new station on an existing track, lined up with it. Platforms need straight track, so if the clicked
// spot is on a curve the station slides to the nearest place along the line (within 250 m) where it fits.
function buildStationOnTrack(t, x, y, type, opts = {}) {
  const s0 = alongTrack(t, x, y);
  let spot = null;
  for (let off = 0; off <= 250 && !spot; off += 10) for (const sg of off ? [off, -off] : [0]) {
    if (s0 + sg < 0 || s0 + sg > t.len) continue;
    const q = pointAtLength(t, s0 + sg);
    if (!splitTrack(t, q.x, q.y, { id: -1, x: q.x, y: q.y, ang: q.ang, plen: opts.plen }, true).err) { spot = q; break; }
  }
  if (!spot) { toast('No room for a station here — platforms need a straight run of track and space from the ends', true); return null; }
  const s = buildStation(spot.x, spot.y, type, spot.ang, opts);
  if (s) splitTrack(t, s.x, s.y, s);
  if (s && Math.hypot(spot.x - x, spot.y - y) > 25) toast(`${s.name} placed on the nearest straight track`);
  return s;
}

// ---------- pathfinding on the track graph (by length)
// Search state is (node, track we arrived on) so trains never reverse through a junction or station.
const trackDir = (t, rev, atEnd) => {
  const p = rev ? t.pts.slice().reverse() : t.pts, n = p.length;
  const [a, b] = atEnd ? [p[n - 2], p[n - 1]] : [p[0], p[1]];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};
const turnDeg = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d * 180 / Math.PI; };
function trackPath(fromId, toId, arriveDir = null) {
  const adj = new Map();
  for (const t of G.tracks) {
    if (t.planned) continue;   // routes only run on built track
    if (!adj.has(t.a)) adj.set(t.a, []);
    if (!adj.has(t.b)) adj.set(t.b, []);
    adj.get(t.a).push({ t, to: t.b, rev: false });
    adj.get(t.b).push({ t, to: t.a, rev: true });
  }
  const start = { node: fromId, dir: arriveDir, d: 0, prev: null, step: null };
  const open = [start], seen = new Set();
  // ponytail: O(V²) dijkstra over (node, incoming track), fine for a few hundred nodes
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i;
    const u = open.splice(bi, 1)[0];
    if (u.node === toId && u !== start) {
      const out = [];
      for (let s = u; s.step; s = s.prev) out.unshift(s.step);
      return out;
    }
    const key = u.node + '|' + (u.step ? u.step.t : '');
    if (seen.has(key)) continue;
    seen.add(key);
    for (const e of adj.get(u.node) || []) {
      if (u.step && e.t.id === u.step.t) continue;
      if (u.dir !== null && turnDeg(u.dir, trackDir(e.t, e.rev, false)) > MAX_THROUGH) continue;
      open.push({ node: e.to, dir: trackDir(e.t, e.rev, true), d: u.d + e.t.len, prev: u, step: { t: e.t.id, rev: e.rev } });
    }
  }
  return null;
}

// ---------- route timing
function runTime(pts) {
  const L = polyLen(pts);
  let t = L >= VMAX * VMAX / ACC ? L / VMAX + VMAX / ACC : 2 * Math.sqrt(L / ACC);
  // curves: local radius ≈ arc length / turn angle; speed limited to √(lateral accel × radius)
  let slowest = VMAX;
  for (let i = 1; i <= pts.length - 1; i++) {
    const th = i < pts.length - 1 ? bendAngle(pts[i - 1], pts[i], pts[i + 1]) * Math.PI / 180 : 0;
    if (th < 0.02) {   // end of a curve: pay to brake into it and accelerate back out once
      if (slowest < VMAX) t += (VMAX - slowest) ** 2 / (VMAX * ACC);
      slowest = VMAX;
      continue;
    }
    const l = (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])) / 2;
    const v = Math.max(4, Math.min(VMAX, Math.sqrt(1.0 * l / th)));
    t += l * (1 / v - 1 / VMAX);
    slowest = Math.min(slowest, v);
  }
  return t;
}
function legPoints(leg) {
  const pts = [];
  for (const p of leg) {
    const tp = TR(p.t).pts, seq = p.rev ? tp.slice().reverse() : tp;
    for (let i = pts.length ? 1 : 0; i < seq.length; i++) pts.push(seq[i]);
  }
  return pts;
}
function computeRoute(r) {
  r.legPts = r.legs.map(legPoints);
  r.legLen = r.legPts.map(polyLen);
  r.legTime = r.legPts.map(runTime);
  r.half = r.legTime.reduce((s, t) => s + t + DWELL, 0) + TURNAROUND;
  r.cycle = 2 * r.half;
  r.length = r.legLen.reduce((a, b) => a + b, 0);
  r.maxTrains = Math.max(1, Math.floor(r.cycle / MIN_HEADWAY));
  r.trains = Math.min(r.trains, r.maxTrains);
  r.headway = r.cycle / Math.max(1, r.trains);
  r.capHour = 3600 / r.headway * r.cars * CAR_CAP;
  if (!r.crowd || r.crowd.length !== r.legs.length) r.crowd = r.legs.map(() => 1);
}

// ---------- routes
function createRoute(stops, legs) {
  const used = new Set(G.routes.map(r => r.name)), usedC = new Set(G.routes.map(r => r.color));
  const r = {
    id: G.nextId++, name: ROUTE_NAMES.find(n => !used.has(n)) || String(G.nextId),
    color: ROUTE_COLORS.find(c => !usedC.has(c)) || ROUTE_COLORS[G.routes.length % ROUTE_COLORS.length],
    stops, legs, trains: 0, cars: 6,
  };
  r.cars = Math.min(6, routeMaxCars(r));
  computeRoute(r);
  const want = Math.min(r.maxTrains, Math.max(1, Math.ceil(r.cycle / 360)));   // ~6 min headway
  const afford = Math.floor(G.money / (r.cars * CAR_COST));
  if (afford < 1) { toast('Not enough money to buy a train for this route', true); return null; }
  G.routes.push(r);
  setTrains(r, Math.min(want, afford));
  markDirty();
  toast(`Route ${r.name} opened with ${r.trains} trains`);
  return r;
}
function updateRouteStops(r, stops, legs) {
  r.stops = stops; r.legs = legs; r.crowd = null;
  computeRoute(r);
  markDirty();
}
function setTrains(r, n) {
  n = Math.max(1, Math.min(r.maxTrains, n));
  const d = n - r.trains;
  if (d > 0 && !spend(d * r.cars * CAR_COST, 'trains')) return;
  if (d < 0) G.money += -d * r.cars * CAR_COST * 0.5;
  r.trains = n;
  computeRoute(r); markDirty();
}
const routeMaxCars = r => Math.min(10, ...r.stops.map(id => maxCarsAt(ST(id))));   // trains must fit every platform
function setCars(r, n) {
  n = Math.max(2, Math.min(routeMaxCars(r), n));
  const d = (n - r.cars) * r.trains;
  if (d > 0 && !spend(d * CAR_COST, 'trains')) return;
  if (d < 0) G.money += -d * CAR_COST * 0.5;
  r.cars = n;
  computeRoute(r); markDirty();
}
function deleteRoute(r) {
  G.money += r.trains * r.cars * CAR_COST * 0.5;
  G.routes = G.routes.filter(x => x !== r);
  markDirty();
  toast(`Route ${r.name} closed — trains sold for ${fmtMoney(r.trains * r.cars * CAR_COST * 0.5)}`);
}

// ---------- formatting
function fmtMoney(v) {
  const s = v < 0 ? '-' : '', a = Math.abs(v);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}
const fmtInt = v => Math.round(v).toLocaleString('en-US');
