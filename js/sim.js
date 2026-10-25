'use strict';
// Commuter simulation (mode choice + transit assignment), clock, finances, goals, saving.

const ACCESS_R = 1200;   // max walk to a station, m
const WALK_MPM = 75;     // walking speed, m/min
const VOT = 0.3;         // value of time, $/min
const BETA = 0.07;       // logit sensitivity, 1/min
const PEAK = 0.25;       // share of one-way commute in the peak hour
const ST_MAINT = 3000, TR_MAINT_KM = 1500;   // $/day
const BOND = 500e6, BOND_RATE = 0.045, BOND_DAYS = 3650, MAX_BONDS = 6;
const SPEEDS = [0, 1, 6, 30, 180];           // game minutes per real second
const PROFILE = (() => {
  const p = [0.3, 0.2, 0.15, 0.2, 0.5, 1.5, 4, 8, 9, 5, 3.5, 3.5, 4, 3.8, 3.8, 4.5, 6.5, 8.5, 7, 4.5, 3.2, 2.5, 1.6, 0.8];
  const s = p.reduce((a, b) => a + b);
  return p.map(v => v / s);
})();
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let assignDirty = true, assignAt = 0, candCache = { key: null, groups: null, cand: null };
function markDirty() { G.version++; assignDirty = true; assignAt = performance.now() + 250; }

// Car and walk costs don't depend on the network: compute once.
function prepGroups() {
  const C = G.city;
  for (const g of C.groups) {
    const jn = C.jobN[g.wc], pn = C.popN[g.hc];
    const road = g.dist * 1.3;
    const speed = 500 * (1 - 0.55 * (jn + pn) / 2);              // m/min, congestion near dense areas
    const time = 5 + road / speed + 12 * jn;                      // incl. parking search
    const money = road / 1000 * 0.35 + 25 * jn ** 1.5;            // fuel + parking
    g.car = time + money / VOT + 22 * pn;                         // dense areas own fewer cars
    g.walk = g.dist < 4500 ? g.dist * 1.3 / WALK_MPM * 1.4 : Infinity;
  }
}

function crowdMult(c) { return c < 0.7 ? 1 : 1 + (c - 0.7) * 0.8 + (c > 1 ? (c - 1) * 4 : 0); }

// Binary-heap dijkstra over a CSR graph
// sifts move a hole instead of swapping pairs (destructuring swaps were ~15% of an assignment)
function dijkstra(src, N, off, eTo, eW, dist, pred, heap) {
  dist.fill(Infinity); pred.fill(-1);
  dist[src] = 0;
  let hn = 0;
  const push = (n, d) => {
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= d) break;
      heap[i * 2] = heap[p * 2]; heap[i * 2 + 1] = heap[p * 2 + 1];
      i = p;
    }
    heap[i * 2] = d; heap[i * 2 + 1] = n;
  };
  push(src, 0);
  while (hn) {
    const d = heap[0], u = heap[1];
    hn--;
    const ld = heap[hn * 2], ln = heap[hn * 2 + 1];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = -1, md = ld;
      if (l < hn && heap[l * 2] < md) { m = l; md = heap[l * 2]; }
      if (r < hn && heap[r * 2] < md) m = r;
      if (m < 0) break;
      heap[i * 2] = heap[m * 2]; heap[i * 2 + 1] = heap[m * 2 + 1];
      i = m;
    }
    heap[i * 2] = ld; heap[i * 2 + 1] = ln;
    if (d > dist[u]) continue;
    for (let e = off[u]; e < off[u + 1]; e++) {
      const nd = d + eW[e], v = eTo[e];
      if (nd < dist[v]) { dist[v] = nd; pred[v] = e; push(v, nd); }
    }
  }
}

function runAssignment() {
  const C = G.city, st = builtStations(), S = st.length, groups = C.groups;
  const routes = G.routes;
  const res = {
    trips: 0, transit: 0, car: 0, walk: 0, total: 0,
    stationUse: new Map(), routeRiders: new Map(), flows: [], served: 0, transfers: new Map(), complexTransfers: new Map(),
  };
  // access candidates
  // stations bucketed into ACCESS_R cells so each lookup checks only 3x3 buckets
  const buckets = new Map(), bk = (i, j) => i * 100003 + j;
  st.forEach((s, i) => { const k = bk(Math.floor(s.x / ACCESS_R), Math.floor(s.y / ACCESS_R)); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); });
  const near = (x, y) => {
    const out = [], ci = Math.floor(x / ACCESS_R), cj = Math.floor(y / ACCESS_R);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of buckets.get(bk(ci + a, cj + b)) || []) {
      const d = Math.sqrt((st[i].x - x) ** 2 + (st[i].y - y) ** 2);
      if (d < ACCESS_R) out.push(i, d * 1.25 / WALK_MPM);
    }
    return out;
  };
  // stations nearest each group only change when stations do (~20% of the run otherwise)
  const candKey = st.map(s => s.x + ',' + s.y).join(';');
  if (routes.length && (candCache.key !== candKey || candCache.groups !== groups)) candCache = { key: candKey, groups, cand: groups.map(g => [near(g.hx, g.hy), near(g.wx, g.wy)]) };
  const cand = routes.length ? candCache.cand : null;
  const sIdx = new Map(st.map((s, i) => [s.id, i]));
  let lastFlow = null, boards = null, alights = null, routeBoard = null, xfer = null;
  const share = new Float32Array(groups.length), choice = new Int32Array(groups.length * 2).fill(-1);

  // changing between platforms: inside a transfer complex it's stairs and passages (kind 4: TRANSFER_MIN + a minute
  // per level climbed); otherwise walking along the street to a station within 400 m (kind 3). Same every iteration.
  const walkE = [];
  for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) {
    if (st[i].complex && st[i].complex === st[j].complex) {
      const w = TRANSFER_MIN + TRANSFER_LEVEL * Math.abs(LEVELS.indexOf(st[i].type) - LEVELS.indexOf(st[j].type));
      walkE.push([i, j, w, 4, -1, -1, 0, -1], [j, i, w, 4, -1, -1, 0, -1]);
      continue;
    }
    const d = Math.hypot(st[i].x - st[j].x, st[i].y - st[j].y);
    if (d < 400) { const w = d / WALK_MPM * 1.5 + 1; walkE.push([i, j, w, 3, -1, -1, 0, -1], [j, i, w, 3, -1, -1, 0, -1]); }
  }
  const iters = routes.length ? 3 : 1;
  for (let it = 0; it < iters; it++) {
    // --- build graph: nodes 0..S-1 = street level, then one platform per route stop
    const E = [];   // [from, to, w, kind, route, leg, dir, station]
    let N = S;
    routes.forEach((r, ri) => {
      r._base = N; N += r.stops.length;
      const wait = r.headway / 60 / 2;
      r.stops.forEach((sid, k) => {
        const s = sIdx.get(sid), p = r._base + k;
        E.push([s, p, 2 + 1.5 * wait, 0, ri, -1, 0, s], [p, s, 0.3, 1, ri, -1, 0, s]);
        if (k < r.stops.length - 1) {
          const w = r.legTime[k] / 60 * r.crowd[k] + DWELL / 60;
          E.push([p, p + 1, w, 2, ri, k, 0, -1], [p + 1, p, w, 2, ri, k, 1, -1]);
        }
      });
    });
    E.push(...walkE);
    E.sort((a, b) => a[0] - b[0]);
    const M = E.length, off = new Int32Array(N + 1), eTo = new Int32Array(M), eFrom = new Int32Array(M), eW = new Float64Array(M);
    for (let e = 0; e < M; e++) { off[E[e][0] + 1]++; eTo[e] = E[e][1]; eFrom[e] = E[e][0]; eW[e] = E[e][2]; }
    for (let n = 0; n < N; n++) off[n + 1] += off[n];

    // --- all-pairs from each station
    const T = new Float64Array(S * S), P = new Int32Array(S * N);
    const dist = new Float64Array(N), pred = new Int32Array(N), heap = new Float64Array(M * 2 + 4);
    for (let s = 0; s < S; s++) {
      dijkstra(s, N, off, eTo, eW, dist, pred, heap);
      for (let d = 0; d < S; d++) T[s * S + d] = dist[d];
      P.set(pred, s * N);
    }

    // --- mode choice + loading
    const flow = routes.map(r => r.legs.map(() => [0, 0]));
    boards = new Float64Array(S); alights = new Float64Array(S); routeBoard = new Float64Array(routes.length); xfer = new Float64Array(S);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      let best = Infinity, bo = -1, bd = -1;
      if (cand) {
        const [oc, dc] = cand[gi];
        for (let a = 0; a < oc.length; a += 2) {
          const row = oc[a] * S, wo = 1.5 * oc[a + 1];
          for (let b = 0; b < dc.length; b += 2) {
            if (oc[a] === dc[b]) continue;
            const c = wo + T[row + dc[b]] + 1.5 * dc[b + 1];
            if (c < best) { best = c; bo = oc[a]; bd = dc[b]; }
          }
        }
      }
      const tg = best + G.fare / VOT;
      const m = Math.min(g.car, g.walk, tg);
      const ec = Math.exp(-BETA * (g.car - m)), ew = Math.exp(-BETA * (g.walk - m)), et = Math.exp(-BETA * (tg - m));
      const pt = et / (ec + ew + et);
      share[gi] = pt;
      choice[gi * 2] = bo; choice[gi * 2 + 1] = bd;
      if (!(pt > 1e-4)) { share[gi] = 0; continue; }
      const f = g.size * pt, base = bo * N;
      for (let n = bd; n !== bo;) {
        const e = P[base + n];
        if (e < 0) break;
        const ed = E[e];
        if (ed[3] === 2) flow[ed[4]][ed[5]][ed[6]] += f;
        else if (ed[3] === 0) { boards[ed[7]] += f; routeBoard[ed[4]] += f; }
        else if (ed[3] === 1) alights[ed[7]] += f;
        else if (ed[3] === 4) { xfer[ed[0]] += f; xfer[ed[1]] += f; }
        n = eFrom[e];
      }
    }
    // --- crowding feedback
    routes.forEach((r, ri) => {
      r.load = flow[ri].map(([a, b]) => Math.max(a, b) * PEAK / r.capHour);
      r.legFlow = flow[ri].map(([a, b]) => a + b);
      r.crowd = r.load.map((c, k) => it === 0 ? crowdMult(c) : 0.5 * (r.crowd[k] + crowdMult(c)));
    });
    lastFlow = flow;
  }

  // --- results
  const ZW = Math.ceil(C.W / 2000), ZH = Math.ceil(C.H / 2000);
  const zone = (x, y) => Math.min(ZW - 1, Math.max(0, Math.floor(x / 2000))) + ZW * Math.min(ZH - 1, Math.max(0, Math.floor(y / 2000)));
  const zf = new Map();
  groups.forEach((g, gi) => {
    const pt = share[gi];
    const m = Math.min(g.car, g.walk);
    const ec = Math.exp(-BETA * (g.car - m)), ew = Math.exp(-BETA * (g.walk - m));
    res.transit += g.size * pt;
    res.car += g.size * (1 - pt) * ec / (ec + ew);
    res.walk += g.size * (1 - pt) * ew / (ec + ew);
    res.total += g.size;
    if (choice[gi * 2] >= 0) res.served += g.size;
    g.o = choice[gi * 2] >= 0 ? st[choice[gi * 2]].id : -1;
    g.d = choice[gi * 2 + 1] >= 0 ? st[choice[gi * 2 + 1]].id : -1;
    g.pt = pt;
    const z1 = zone(g.hx, g.hy), z2 = zone(g.wx, g.wy);
    if (z1 === z2) return;
    const k = z1 * ZW * ZH + z2, v = zf.get(k) || [0, 0];
    v[0] += g.size; v[1] += g.size * pt;
    zf.set(k, v);
  });
  res.trips = res.transit * 2;
  res.flows = [...zf.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 160).map(([k, v]) => {
    const z1 = Math.floor(k / (ZW * ZH)), z2 = k % (ZW * ZH);
    return { x1: (z1 % ZW + 0.5) * 2000, y1: (Math.floor(z1 / ZW) + 0.5) * 2000, x2: (z2 % ZW + 0.5) * 2000, y2: (Math.floor(z2 / ZW) + 0.5) * 2000, n: v[0], t: v[1] };
  });
  st.forEach((s, i) => res.stationUse.set(s.id, boards ? boards[i] + alights[i] : 0));
  // transfers per day (each commuter changes on the way out and back): per platform, and per complex
  st.forEach((s, i) => {
    if (!xfer) return;
    res.transfers.set(s.id, xfer[i] * 2);
    if (s.complex) res.complexTransfers.set(s.complex, (res.complexTransfers.get(s.complex) || 0) + xfer[i]);
  });
  routes.forEach((r, ri) => res.routeRiders.set(r.id, routeBoard ? routeBoard[ri] * 2 : 0));
  G.res = res;
}

// ---------- clock & money
function totalCars() { return G.routes.reduce((s, r) => s + r.trains * r.cars, 0); }
function trackKm() { return G.tracks.reduce((s, t) => s + (t.planned ? 0 : t.len), 0) / 1000; }
function dailyOpex() { return totalCars() * CAR_HOUR * 24 + builtStations().length * ST_MAINT + trackKm() * TR_MAINT_KM; }

function tick(dtReal) {
  if (assignDirty && performance.now() >= assignAt) { assignDirty = false; runAssignment(); }
  let dm = dtReal * SPEEDS[G.speed];
  const trips = G.res ? G.res.trips : 0;
  const opsPerMin = totalCars() * CAR_HOUR / 60;
  const maintPerMin = (builtStations().length * ST_MAINT + trackKm() * TR_MAINT_KM) / 1440;
  while (dm > 1e-9) {
    const intoDay = G.minute % 1440;
    const step = Math.min(dm, 60 - intoDay % 60, 1440 - intoDay);
    const hour = Math.floor(intoDay / 60);
    const fares = trips * PROFILE[hour] / 60 * step * G.fare;
    G.money += fares - (opsPerMin + maintPerMin) * step;
    G.today.fares += fares; G.today.ops += opsPerMin * step; G.today.maint += maintPerMin * step;
    const day = Math.floor(G.minute / 1440 + 1e-9);
    G.minute += step; dm -= step;
    if (Math.floor(G.minute / 1440 + 1e-9) > day) { G.minute = Math.round(G.minute); endOfDay(); }
  }
}

function endOfDay() {
  for (const b of G.bonds) {
    const r = BOND_RATE / 365, interest = b.bal * r;
    const pay = Math.min(b.pay, b.bal + interest);
    b.bal -= pay - interest;
    G.money -= pay; G.today.interest += pay;
  }
  G.bonds = G.bonds.filter(b => b.bal > 1);
  const t = G.today;
  const income = t.fares + t.rewards, cost = t.ops + t.maint + t.interest;
  G.history.push({ day: dayNum() - 1, trips: G.res ? G.res.trips : 0, income, cost, capex: t.construction + t.trains, money: G.money });
  if (G.history.length > 400) G.history.shift();
  G.lastDay = t;
  G.today = blankDay();
  checkGoals();
  saveGame(true);
}

function takeBond() {
  if (G.bonds.length >= MAX_BONDS) { toast('Bond limit reached', true); return; }
  const r = BOND_RATE / 365;
  G.bonds.push({ bal: BOND, pay: BOND * r / (1 - Math.pow(1 + r, -BOND_DAYS)) });
  G.money += BOND;
  toast(`Issued a ${fmtMoney(BOND)} bond`);
}
function repayBond(i) {
  const b = G.bonds[i];
  if (!b || G.money < b.bal) { toast('Not enough money to repay this bond', true); return; }
  G.money -= b.bal;
  G.bonds.splice(i, 1);
  toast('Bond repaid');
}

const dayNum = () => Math.floor(G.minute / 1440) + 1;
function clockStr() {
  const d = dayNum(), m = Math.floor(G.minute % 1440);
  return `${DAYS[(d - 1) % 7]} · Day ${d} · ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---------- goals (ridership targets scale with the city's real commuter count)
const niceNum = v => { const m = Math.pow(10, Math.floor(Math.log10(v))); return Math.round(v / m * 2) / 2 * m; };
let GOALS = [];
function makeGoals() {
  const T = G.city.totalJobs * 2, ap = G.city.airports.map(a => a.name.replace(/ Airport$/, '')).join(' / ');
  const ride = (id, f, reward) => { const n = niceNum(T * f); return { id, text: `Carry ${fmtInt(n)} riders per day`, reward, check: () => G.res && G.res.trips >= n }; };
  GOALS = [
    { id: 'route1', text: 'Open your first route', reward: 100e6, check: () => G.routes.length >= 1 },
    ride('r1', 0.02, 150e6),
    { id: 'airport', text: `Serve an airport (${ap})`, reward: 200e6, check: () => G.routes.some(r => r.stops.some(id => G.city.airportAt(ST(id).x, ST(id).y))) },
    ride('r2', 0.06, 300e6),
    { id: 'routes3', text: 'Operate 3 routes', reward: 200e6, check: () => G.routes.length >= 3 },
    { id: 'profit', text: 'Run an operating profit for a day', reward: 150e6, check: () => G.lastDay && G.lastDay.fares > G.lastDay.ops + G.lastDay.maint },
    ride('r3', 0.12, 500e6),
    { id: 'st40', text: 'Build 40 stations', reward: 300e6, check: () => builtStations().length >= 40 },
    { id: 'share10', text: 'Reach a 10% transit commute share', reward: 400e6, check: () => G.res && G.res.transit / G.res.total >= 0.1 },
    ride('r4', 0.2, 750e6),
    { id: 'routes8', text: 'Operate 8 routes', reward: 400e6, check: () => G.routes.length >= 8 },
    ride('r5', 0.3, 1e9),
    { id: 'share25', text: 'Reach a 25% transit commute share', reward: 1e9, check: () => G.res && G.res.transit / G.res.total >= 0.25 },
  ];
}
function checkGoals() {
  for (const g of GOALS) {
    if (G.goals[g.id] || !g.check()) continue;
    G.goals[g.id] = dayNum();
    G.money += g.reward; G.today.rewards += g.reward;
    toast(`🏆 Goal complete: ${g.text} — ${fmtMoney(g.reward)} grant`);
  }
}

// ---------- save / load
function saveGame(auto) {
  if (!G) return;
  const data = {
    v: 1, cityId: G.cityId, stations: G.stations, nodes: G.nodes, tracks: G.tracks, nextId: G.nextId, money: G.money, minute: G.minute,
    fare: G.fare, cam: map ? camState() : null, bonds: G.bonds, history: G.history, goals: G.goals, today: G.today, lastDay: G.lastDay,
    routes: G.routes.map(r => ({ id: r.id, name: r.name, color: r.color, shape: r.shape, stops: r.stops, legs: r.legs, trains: r.trains, cars: r.cars })),
  };
  try {
    localStorage.setItem('subwaybuilder2:' + G.cityId, JSON.stringify(data));
    if (!auto) toast('Game saved');
  } catch (e) { if (!auto) toast('Could not save: ' + e.message, true); }
}
function hasSave(cityId) { try { return !!localStorage.getItem('subwaybuilder2:' + cityId); } catch (e) { return false; } }
function loadGame(cityData) {
  let data;
  try { data = JSON.parse(localStorage.getItem('subwaybuilder2:' + cityData.id)); } catch (e) { return false; }
  if (!data) return false;
  newGame(cityData);
  Object.assign(G, {
    stations: data.stations, nodes: data.nodes || [], tracks: data.tracks, nextId: data.nextId, money: data.money, minute: data.minute, fare: data.fare,
    bonds: data.bonds, history: data.history, goals: data.goals, today: data.today || blankDay(), lastDay: data.lastDay, routes: data.routes, cam: data.cam,
  });
  // saves from before control points: keep their shape as control points
  for (const t of G.tracks) if (!t.ctrl) t.ctrl = simplifyPath(t.pts, 3).slice(1, -1).map(p => [p[0], p[1], MIN_RADIUS]);
  reindex();
  G.routes.forEach(computeRoute);
  markDirty();
  return true;
}
