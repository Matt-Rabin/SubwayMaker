// Headless check of real-data loading, construction, routing and simulation: `node tests/smoke.js [cityId]`
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const ctx = { console, Math, performance, map: null, UI: { plan: false }, localStorage: { setItem() {}, getItem() { return null; } }, toast: () => {} };
ctx.window = ctx;
vm.createContext(ctx);
const id = process.argv[2] || 'bos';
for (const f of [`data/${id}.js`, 'js/city.js', 'js/network.js', 'js/sim.js'])
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });

vm.runInContext(`
  let t = performance.now();
  newGame(CITY_DATA['${id}']);
  const C = G.city;
  console.log(C.name, 'loaded in', Math.round(performance.now() - t), 'ms;', C.groups.length, 'groups,', Math.round(C.totalJobs), 'commuters,', (C.W / 1000).toFixed(1) + 'x' + (C.H / 1000).toFixed(1), 'km');
  // a deep-bore line through the busiest job cell
  const [cx, cy] = C.cbd, ids = [];
  for (let k = -4; k <= 4; k++) { const s = buildStation(cx + k * 900, cy + k * 250, 'deep'); if (s) ids.push(s.id); }
  for (let k = 1; k < ids.length; k++) if (!buildTrack(ids[k - 1], ids[k], [], 'deep')) throw new Error('track failed');
  const p = trackPath(ids[0], ids[ids.length - 1]);
  if (!p || p.length !== ids.length - 1) throw new Error('pathfinding failed');
  const r = createRoute(ids.slice(), p.map(x => [x]));
  if (!r) throw new Error('route failed');
  t = performance.now();
  runAssignment();
  console.log('  ', ids.length, 'stations,', r.trains, 'trains; riders/day', Math.round(G.res.trips), 'share', (G.res.transit / G.res.total * 100).toFixed(2) + '%; assign', Math.round(performance.now() - t), 'ms');
  if (!(G.res.trips > 1000)) throw new Error('no riders');
  // --- time of day: fewer trains at night means fewer riders then; the fleet covers the busiest block
  const blk = G.res.blocks;
  if (!(blk.peak.trips > blk.night.trips)) throw new Error('night service should carry fewer riders than rush hour');
  const fleet0 = r.trains, m0t = G.money;
  setService(r, 'night', r.service.night + 1);
  if (r.trains !== fleet0 || G.money !== m0t) throw new Error('night trains within the fleet should cost nothing to add');
  setService(r, 'day', r.trains + 1);
  if (r.trains !== fleet0 + 1 || !(G.money < m0t)) throw new Error('exceeding the fleet should buy a train');
  if (!(runningCars('night') < runningCars('peak') || r.service.night >= r.service.peak)) throw new Error('night opex not lower');
  console.log('   time of day ok: rush', Math.round(blk.peak.trips), '/ day', Math.round(blk.day.trips), '/ night', Math.round(blk.night.trips), 'daily-equivalent trips');
  // --- branching: split track A-B mid-span into a junction, branch off it to D
  const nd = (dx, dy) => { const s = buildStation(cx + dx, cy + dy + 6000, 'deep'); if (!s) throw new Error('station failed'); return s; };
  const A = nd(0, 0), B = nd(2000, 0), Cn = nd(4000, 0), D = nd(2000, 900);
  const tAB = buildTrack(A.id, B.id, [], 'deep'); buildTrack(B.id, Cn.id, [], 'deep');
  const trunk = createRoute([A.id, B.id, Cn.id], [[{ t: tAB.id, rev: false }], trackPath(B.id, Cn.id)]);
  const j = splitTrack(tAB, cx + 1000, cy + 6000);
  if (!j || !j.junction) throw new Error('split failed');
  if (G.tracks.includes(tAB)) throw new Error('old track not replaced');
  computeRoute(trunk);
  if (Math.abs(trunk.legLen[0] - 2000) > 1) throw new Error('trunk route broken by split: ' + trunk.legLen[0]);
  if (!buildTrack(j.id, D.id, [], 'deep')) throw new Error('branch track failed');
  const pAD = trackPath(A.id, D.id);
  if (!pAD || pAD.length !== 2) throw new Error('no path through junction');
  if (trackPath(B.id, D.id)) throw new Error('path should not reverse through the junction');
  const branch = createRoute([A.id, D.id], [pAD]);
  if (!branch) throw new Error('branch route failed');
  if (demolishStation(j)) throw new Error('used junction was demolished');
  const ins = buildStationOnTrack(G.tracks.find(t => t.a === B.id && t.b === Cn.id), cx + 3000, cy + 6000, 'deep');
  computeRoute(trunk);
  if (!ins || trunk.legs[1].length !== 2) throw new Error('station insert did not split the trunk');
  runAssignment();
  console.log('   branching ok: trunk', Math.round(G.res.routeRiders.get(trunk.id)), 'riders, branch', Math.round(G.res.routeRiders.get(branch.id)));
  // --- plan mode: placing is free, Build charges the projected total, Discard re-joins split built track
  UI.plan = true;
  const m0 = G.money, p1 = buildStation(cx - 2000, cy + 4000, 'deep', 0.3), p2 = buildStation(cx - 600, cy + 4400, 'deep');
  const pt = buildTrack(p1.id, p2.id, [[p1.x + 700, p1.y - 300, Infinity]], 'deep');
  if (!pt || G.money !== m0 || !p1.planned || !pt.planned) throw new Error('planning spent money or was not marked planned');
  if (trackPath(p1.id, p2.id)) throw new Error('routes can use planned track');
  const projected = planTotal();
  if (!commitPlan() || Math.abs(m0 - projected - G.money) > 1 || planItems().length) throw new Error('commit did not charge the projected cost');
  const tAJ = G.tracks.find(t => t.a === A.id && t.b === j.id);
  buildStationOnTrack(tAJ, cx + 500, cy + 6000, 'deep');
  if (trunk.legs[0].length !== 3) throw new Error('planned station did not split the trunk');
  discardPlan();
  computeRoute(trunk);
  if (trunk.legs[0].length !== 2 || Math.abs(trunk.legLen[0] - 2000) > 1) throw new Error('discard did not restore the trunk: ' + trunk.legs[0].length);
  UI.plan = false;
  console.log('   plan mode ok: projected', fmtMoney(projected), 'charged on Build; discard restored split track');
  // --- cost rules: water band between x0+500..x0+700, a 30 m tall building at x0+300..x0+340
  // somewhere well away from the other test pieces but inside the census area (downtown can sit near an edge)
  const [x0, y0] = [[-3000, 9000], [-3000, -9000], [3000, 9000], [3000, -9000], [-6000, 5000], [6000, -5000]]
    .map(([dx, dy]) => [cx + dx, cy + dy]).find(([x, y]) => C.inside(x, y) && C.inside(x + 1000, y + 200));
  const wa = C.waterAt, ba = C.buildingAt, da = C.densAt;
  C.densAt = () => 0.5;   // same density on the wet and dry test rows, so only the water rule differs
  C.waterAt = (x, y) => Math.abs(y - y0) < 50 && x > x0 + 500 && x < x0 + 700 ? 1 : 0;
  C.buildingAt = (x, y) => Math.abs(y - y0) < 20 && x > x0 + 300 && x < x0 + 340 ? { id: 'b1', h: 30 } : null;
  const seg = [[x0, y0], [x0 + 1000, y0]], dry = [[x0, y0 + 200], [x0 + 1000, y0 + 200]];
  if (!trackCost(seg, 'atgrade').err) throw new Error('at-grade crossed water');
  for (const [type, mult] of [['elevated', 4], ['cutcover', 6], ['deep', 3]]) {
    const wet = trackCost(seg, type), base = trackCost(dry, type);
    if (wet.err) throw new Error(type + ' refused water');
    // 200 of 1000 m is water, priced at km cost × mult instead of the land rate
    const expect = base.cost * 0.8 + TYPES[type].km * 0.2 * mult;
    if (Math.abs(wet.cost - wet.demoCost - expect) > expect * 0.05 || !(wet.cost > base.cost)) throw new Error(type + ' underwater cost wrong: ' + Math.round(wet.cost - wet.demoCost) + ' vs ' + Math.round(expect));
  }
  const cc = trackCost(seg, 'cutcover'), db = trackCost(seg, 'deep');
  if (cc.demolished !== 1 || Math.abs(cc.demoCost - demolitionCost(30)) > 1) throw new Error('demolition not charged');
  if (db.demolished) throw new Error('deep bore should not demolish');
  C.waterAt = wa; C.buildingAt = ba; C.densAt = da;
  console.log('   costs ok: cut&cover demolition', fmtMoney(cc.demoCost));
  // --- track rules: corners become arcs ≥ MIN_RADIUS, track leaves a station along its platform, minimum length
  const end = (x, y) => ({ id: -9, x, y, end: true });
  const g90 = trackGeometry(end(0, 0), [[400, 0]], end(400, 400));
  if (g90.err) throw new Error('90° corner rejected: ' + g90.err);
  for (let i = 1; i < g90.pts.length - 1; i++) if (bendAngle(g90.pts[i - 1], g90.pts[i], g90.pts[i + 1]) > 10) throw new Error('corner not rounded');
  if (!trackGeometry(end(0, 0), [[40, 0]], end(40, 40)).err) throw new Error('too-tight corner allowed');
  const st = { id: -8, x: 0, y: 0, ang: 0 };   // a station facing east
  const gs = trackGeometry(st, [], end(600, 600));
  if (gs.err || gs.pts.some(p => Math.hypot(p[0], p[1]) <= PLATFORM / 2 && Math.abs(p[1]) > 0.01)) throw new Error('track does not leave the platform straight');
  if (!trackGeometry(st, [], { id: -7, x: 100, y: 0, ang: 0 }).err) throw new Error('overlapping stations allowed');
  if (!buildStation(cx + 300, cy - 3000, 'deep') || !buildStation(cx + 450, cy - 3000, 'deep')) throw new Error('station spacing limit still applied');
  // --- control points: drag one, the track and its routes follow
  const tBC = G.tracks.find(t => routesUsingTrack(t.id).includes(trunk) && t.b === Cn.id);
  const len0 = tBC.len;
  if (!editTrack(tBC, [[(ST(tBC.a).x + Cn.x) / 2, cy + 6000 + 250, CTRL_R]])) throw new Error('control point edit rejected');
  computeRoute(trunk);
  if (!(tBC.len > len0 + 10)) throw new Error('edited track did not change shape');
  // --- station customisation: long platform allows longer trains, short one limits them
  if (!restyleStation(A, { plen: PLATFORMS.long }) || plen(A) !== 180) throw new Error('platform length change failed');
  renameStation(A, 'Test Central');
  if (A.name !== 'Test Central') throw new Error('rename failed');
  // --- transfers: an elevated platform added to a deep station joins one complex; riders change between the lines
  G.money = 1e10;
  const X0 = cx - 1500, Y0 = cy - 2200, H = Math.PI / 2;
  const W1 = buildStation(X0 - 1500, Y0, 'deep'), X = buildStation(X0, Y0, 'deep'), E1 = buildStation(X0 + 1500, Y0, 'deep');
  if (buildTransfer(X, 'deep', 0)) throw new Error('same-level overlapping transfer platform allowed');
  const T = buildTransfer(X, 'elevated', H);
  if (!T || !X.complex || T.complex !== X.complex || T.name !== X.name) throw new Error('transfer platform not joined to the station');
  const N1 = buildStation(X0, Y0 - 1500, 'elevated', H), S1 = buildStation(X0, Y0 + 1500, 'elevated', H);
  for (const [a, b, ty] of [[W1, X, 'deep'], [X, E1, 'deep'], [N1, T, 'elevated'], [T, S1, 'elevated']]) if (!buildTrack(a.id, b.id, [], ty)) throw new Error('transfer test track failed');
  const line = (...ss) => createRoute(ss.map(s => s.id), ss.slice(1).map((s, k) => trackPath(ss[k].id, s.id)));
  line(W1, X, E1); line(N1, T, S1);
  runAssignment();
  const xfers = G.res.complexTransfers.get(X.complex) || 0;
  if (!(xfers > 0)) throw new Error('nobody transferred between the crossing lines');
  renameStation(T, 'Crossing');
  if (X.name !== 'Crossing') throw new Error('complex rename did not reach every platform');
  console.log('   transfers ok:', Math.round(xfers * 2), 'transfers/day at', X.name);
  console.log('   track rules ok: 90° corner →', g90.pts.length, 'arc points; control-point edit', (len0 / 1000).toFixed(2), '→', (tBC.len / 1000).toFixed(2), 'km');
  G.speed = 4;
  for (let i = 0; i < 1440 * 2; i++) tick(1 / SPEEDS[4]);
  console.log('   days', G.history.length, 'money', fmtMoney(G.money), 'goals', Object.keys(G.goals).join(','));
  if (G.history.length < 2) throw new Error('day rollover failed');
`, ctx);
console.log('smoke ok');
