'use strict';
// Input handling, panels, menus and the main loop.

const UI = {
  tool: 'select', build: 'cutcover', overlay: 'none', tab: 'routes', followRoads: false,
  plan: true,              // plan mode: placements are a costed blueprint until Build
  shape: 'straight',       // track drawing: straight | curve | free
  stationAt: null,         // first click of a station placement (its centre)
  transferOf: null,        // station a transfer platform is being added to
  curveCtrl: null,         // bend point of a curve being drawn
  sel: null, hover: null, mouse: { x: 0, y: 0, in: false, shift: false },
  from: null,              // start of the track being drawn: {id} node, {track,x,y,ang} point on track, or {x,y}
  ctrl: [],                // its control points so far [x, y, radius]
  drag: null,              // control point being dragged on an existing track
  routeDraft: null, menuOpen: true,
  panelOpen: false,        // right panel: just the tab names until one is clicked
};
const ELEVATIONS = LEVELS;   // stepped with ↑ / ↓
const SHAPES = ['straight', 'curve', 'free'];
const $ = id => document.getElementById(id);

// ---------- toasts
function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = 0; }, 3200);
  setTimeout(() => el.remove(), 3700);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

// ---------- hit testing
function hitTest(px, py) {
  let best = null, bd = Infinity;
  for (const s of G.stations) {
    const [e1, e2] = stationEnds(s), d = segDist(px, py, e1[0], e1[1], e2[0], e2[1]);
    if (d < 13 && d < bd) { bd = d; best = { kind: 'station', id: s.id }; }
  }
  if (best) return best;
  for (const j of G.nodes) {
    const [qx, qy] = P(j.x, j.y, nodeAlt(j)), d = Math.hypot(qx - px, qy - py);
    if (d < 10 && d < bd) { bd = d; best = { kind: 'junction', id: j.id }; }
  }
  if (best) return best;
  for (const t of G.tracks) {
    const h = trackProfile(t).pts3.map(p => Ph(p[0], p[1], p[2]));
    for (let i = 1; i < h.length; i++) {
      const s = clipNear(h[i - 1], h[i]), d = s ? segDist(px, py, s[0], s[1], s[2], s[3]) : Infinity;
      if (d < 8 && d < bd) { bd = d; best = { kind: 'track', id: t.id }; }
    }
  }
  return best;
}

// ---------- tools
function setTool(t) {
  UI.tool = t; UI.from = null; UI.ctrl = []; UI.stationAt = null; UI.transferOf = null; UI.curveCtrl = null;
  if (t !== 'route') UI.routeDraft = null;
  if (t === 'route') { UI.tab = 'routes'; UI.panelOpen = true; }
  refreshUI();
}
// right-click / Esc: back out of whatever is being placed, innermost first
function cancelAction() {
  if (UI.stationAt) { UI.stationAt = null; UI.transferOf = null; }
  else if (UI.from) { UI.from = null; UI.ctrl = []; UI.curveCtrl = null; }
  else if (UI.routeDraft) UI.routeDraft = null;
  else if (UI.sel) UI.sel = null;
  else if (UI.tool !== 'select') UI.tool = 'select';
  refreshUI();
}

// ---------- track drawing: a track runs from a start node through control points to an end node (never a station)
const fromNode = () => !UI.from ? null : UI.from.id ? ST(UI.from.id)
  : UI.from.track ? { id: -2, x: UI.from.x, y: UI.from.y, junction: true, ang: UI.from.ang } : { id: -2, x: UI.from.x, y: UI.from.y, end: true };
// what a click lands on, as a track endpoint: a node, a point on a track (becomes a junction), or open ground (a track end)
function endTarget(hit, mx, my) {
  if (hit && (hit.kind === 'station' || hit.kind === 'junction')) return { node: ST(hit.id) };
  if (hit && hit.kind === 'track') {
    const t = TR(hit.id), p = nearestOnTrack(t, mx, my), [a, b] = [t.pts[p.i - 1], t.pts[p.i]], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return { track: t, x: p.x, y: p.y, ang, temp: { id: -3, x: p.x, y: p.y, junction: true, ang } };
  }
  return { x: mx, y: my, temp: { id: -4, x: mx, y: my, end: true } };
}
const targetNode = e => e.node || e.temp;
// control points for a track from node A to `end`, per the chosen shape (shared by the click and its preview)
function draftCtrl(A, end, shift, preview) {
  if (UI.shape === 'curve') return { ctrl: UI.curveCtrl ? [...UI.ctrl, [UI.curveCtrl[0], UI.curveCtrl[1], Infinity]] : UI.ctrl };
  if (UI.shape === 'free') {   // one wide arc bending out of the way the track leaves A
    const ax = UI.ctrl.length ? null : nodeAxis(A);
    if (!ax) return { ctrl: UI.ctrl };
    let dir = ax.ang;
    if (ax.both && Math.cos(dir - Math.atan2(end[1] - A.y, end[0] - A.x)) < 0) dir += Math.PI;
    const d = Math.hypot(end[0] - A.x, end[1] - A.y) / 2;
    return { ctrl: [[A.x + Math.cos(dir) * d, A.y + Math.sin(dir) * d, Infinity]] };
  }
  if (UI.followRoads && !shift) {
    const last = UI.ctrl.length ? UI.ctrl[UI.ctrl.length - 1] : [A.x, A.y];
    const road = preview ? followRoadCached(last, end) : followRoad(last, end);
    if (!road) return { ctrl: UI.ctrl, err: 'No street route found — zoom in so streets are loaded, or turn off Follow roads' };
    return { ctrl: [...UI.ctrl, ...road] };
  }
  return { ctrl: UI.ctrl };
}
function finishTrack(e, shift) {
  const A0 = fromNode(), B0 = targetNode(e);
  if (e.node && UI.from.id === e.node.id) return;
  const d = draftCtrl(A0, [B0.x, B0.y], shift, false);
  if (d.err) return toast(d.err, true);
  const g = trackGeometry(A0, d.ctrl, B0);
  if (g.err) return toast(g.err, true);
  const tc = trackCost(g.pts, UI.build);
  if (tc.err) return toast(tc.err, true);
  const total = tc.cost + (e.track ? JUNCTION_COST : 0) + (UI.from.track ? JUNCTION_COST : 0);
  if (!UI.plan && total > G.money) return toast(`Not enough money — need ${fmtMoney(total)}`, true);
  const A = UI.from.id ? ST(UI.from.id) : UI.from.track ? splitTrack(UI.from.track, UI.from.x, UI.from.y) : addEndNode(UI.from.x, UI.from.y);
  if (!A || !toJunction(A)) { dropOrphanNodes(); reindex(); return; }
  let tB = e.track;
  if (tB && !G.tracks.includes(tB))   // the start split that same track: use the half it's on now
    tB = G.tracks.map(t => [t, nearestOnTrack(t, e.x, e.y).d]).sort((p, q) => p[1] - q[1])[0][0];
  const B = e.node ? (toJunction(e.node) ? e.node : null) : tB ? splitTrack(tB, e.x, e.y) : addEndNode(e.x, e.y);
  if (!B || !buildTrack(A.id, B.id, d.ctrl, UI.build)) { dropOrphanNodes(); reindex(); return; }
  UI.from = { id: B.id }; UI.ctrl = []; UI.curveCtrl = null;   // keep drawing on from here
}
// end the track at its last control point, as a free track end
function endTrackHere() {
  const last = UI.ctrl.pop();
  if (last) finishTrack({ x: last[0], y: last[1], temp: { id: -4, x: last[0], y: last[1], end: true } }, true);
}
// Ctrl+click an existing track: add a control point there
function insertCtrl(t, mx, my) {
  const p = nearestOnTrack(t, mx, my), s0 = alongTrack(t, p.x, p.y), ctrl = (t.ctrl || []).slice();
  const i = ctrl.findIndex(c => alongTrack(t, c[0], c[1]) > s0);
  ctrl.splice(i < 0 ? ctrl.length : i, 0, [p.x, p.y, CTRL_R]);
  editTrack(t, ctrl);
}

function onMapClick(px, py, shift, ctrlKey) {
  if (UI.handleClick) { UI.handleClick = false; return; }   // that click grabbed a control point
  const [mx, my] = Wpt(px, py);
  const hit = hitTest(px, py);
  switch (UI.tool) {
    case 'select':
      if (!hit) { if (!(UI.overlay === 'transit' && importFromOverlay(px, py))) UI.sel = null; }
      else if (hit.kind === 'station' || hit.kind === 'junction') UI.sel = hit;
      else {
        const rs = routesUsingTrack(hit.id);
        if (!rs.length) UI.sel = hit;
        else {   // cycle through routes sharing this track
          const cur = UI.sel && UI.sel.kind === 'route' ? rs.findIndex(r => r.id === UI.sel.id) : -1;
          UI.sel = { kind: 'route', id: rs[(cur + 1) % rs.length].id };
        }
      }
      break;
    case 'station':
      // two clicks: the first sets the centre, the platform then turns to follow the mouse, the second places it
      if (UI.stationAt) {
        const [cx, cy] = UI.stationAt, ang = Math.hypot(mx - cx, my - cy) > 5 ? Math.atan2(my - cy, mx - cx) : 0;
        const s = UI.transferOf ? buildTransfer(ST(UI.transferOf), UI.build, ang) : buildStation(cx, cy, UI.build, ang);
        if (!s && UI.transferOf) break;   // clashing transfer platform: keep placing so it can be turned or moved up/down
        UI.stationAt = null; UI.transferOf = null;
        if (s) UI.sel = { kind: 'station', id: s.id };
      } else if (hit && hit.kind === 'station') {   // add a transfer platform to it, centred on it
        const base = ST(hit.id);
        UI.stationAt = [base.x, base.y]; UI.transferOf = base.id;
      }
      else if (hit && hit.kind === 'junction') toast('Stations can’t sit on a junction or track end — place it along the track', true);
      else if (hit && hit.kind === 'track') {   // on a track the platform lines up with it, so one click
        const s = buildStationOnTrack(TR(hit.id), mx, my, UI.build);
        if (s) UI.sel = { kind: 'station', id: s.id };
      } else {
        const r = stationCost(mx, my, UI.build);
        if (r.err) toast(r.err, true); else UI.stationAt = [mx, my];
      }
      break;
    case 'track': {
      const e = endTarget(hit, mx, my);
      if (ctrlKey && e.track && !UI.from) { insertCtrl(e.track, mx, my); break; }
      if (!UI.from) {
        UI.from = e.node ? { id: e.node.id } : e.track ? { track: e.track, x: e.x, y: e.y, ang: e.ang } : { x: mx, y: my };
        UI.ctrl = []; UI.curveCtrl = null;
        break;
      }
      if (UI.shape === 'curve' && !UI.curveCtrl) { UI.curveCtrl = [mx, my]; break; }   // curve: next click is the bend point
      if (UI.shape === 'straight' && !e.node && !e.track) {   // open ground: a control point (double-click / Enter ends here)
        const d = draftCtrl(fromNode(), [mx, my], shift, false);
        if (d.err) toast(d.err, true); else UI.ctrl = [...d.ctrl, [mx, my, CTRL_R]];
        break;
      }
      finishTrack(e, shift);
      break;
    }
    case 'route':
      if (hit && hit.kind === 'station' && ST(hit.id).planned) toast('That station is only planned — press Build first', true);
      else if (hit && hit.kind === 'station') addRouteStop(hit.id, shift);
      else if (hit && hit.kind === 'junction') toast('Routes stop at stations — click the station beyond it', true);
      break;
    case 'demolish':
      if (!hit) break;
      if (hit.kind === 'station' || hit.kind === 'junction') { if (demolishStation(ST(hit.id)) && UI.sel && UI.sel.id === hit.id) UI.sel = null; }
      else if (demolishTrack(TR(hit.id)) && UI.sel && UI.sel.id === hit.id) UI.sel = null;
      break;
  }
  refreshUI();
}

// ---------- route drafting
function startRouteDraft(r) {
  UI.tool = 'route'; UI.tab = 'routes'; UI.panelOpen = true;
  UI.routeDraft = r
    ? { stops: r.stops.slice(), legs: r.legs.map(l => l.slice()), color: r.color, editing: r.id, name: r.name }
    : { stops: [], legs: [], color: ROUTE_COLORS.find(c => !G.routes.some(r => r.color === c)) || '#888', editing: null, name: 'New route' };
  refreshUI();
}
function addRouteStop(id, express) {
  if (!UI.routeDraft) startRouteDraft(null);
  const d = UI.routeDraft;
  if (!d.stops.length) { d.stops.push(id); return; }
  if (d.stops.includes(id)) { toast('This route already stops there', true); return; }
  // trains keep going the way they arrived: no reversing at a stop or junction mid-route
  const last = d.legs.length ? d.legs[d.legs.length - 1].at(-1) : null;
  const path = trackPath(d.stops[d.stops.length - 1], id, last ? trackDir(TR(last.t), last.rev, true) : null);
  if (!path) { toast('No track path there without reversing — build track or a smoother junction first', true); return; }
  const add = [], legs = [];
  let acc = [];
  for (const p of path) {
    const t = TR(p.t), next = p.rev ? t.a : t.b;
    acc.push(p);
    if (next === id || (!express && !isTrackNode(next) && !ST(next).planned)) { add.push(next); legs.push(acc); acc = []; }
  }
  if (add.some(s => d.stops.includes(s))) { toast('That path doubles back over this route', true); return; }
  d.stops.push(...add); d.legs.push(...legs);
}
function reverseDraft() {
  const d = UI.routeDraft;
  d.stops.reverse();
  d.legs = d.legs.reverse().map(l => l.slice().reverse().map(p => ({ t: p.t, rev: !p.rev })));
}
function undoDraft() {
  const d = UI.routeDraft;
  d.stops.pop();
  if (d.legs.length >= d.stops.length && d.legs.length) d.legs.pop();
}
function finishDraft() {
  const d = UI.routeDraft;
  if (!d || d.stops.length < 2) { toast('A route needs at least 2 stops', true); return; }
  if (d.editing) {
    const r = G.routes.find(r => r.id === d.editing);
    updateRouteStops(r, d.stops, d.legs);
    toast(`Route ${r.name} updated`);
    UI.sel = { kind: 'route', id: r.id };
  } else {
    const r = createRoute(d.stops, d.legs);
    if (!r) return;
    UI.sel = { kind: 'route', id: r.id };
  }
  UI.routeDraft = null; UI.tool = 'select';
  refreshUI();
}

// ---------- panels
// route bullets: a shape in the route colour with the route's symbol on it
const BULLET_SHAPES = {
  circle: '<circle cx="12" cy="12" r="11.5"/>',
  square: '<rect x="1" y="1" width="22" height="22" rx="3"/>',
  diamond: '<path d="M12 0.5 23.5 12 12 23.5 0.5 12Z"/>',
  hexagon: '<path d="M6.3 1.5h11.4L23.5 12l-5.8 10.5H6.3L0.5 12z"/>',
};
const textOn = hex => { const [r, g, b] = hexRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#111' : '#fff'; };
const bullet = (r, lg, act) => {
  const t = String(r.name), size = (t.length > 2 ? 8 : t.length > 1 ? 10.5 : 14) * (r.shape === 'diamond' ? 0.8 : 1);
  return `<span class="bullet${lg ? ' lg' : ''}${act ? ' edit' : ''}"${act ? ` data-act="${act}" data-arg="${r.id}" title="Change shape and symbol"` : ''}><svg viewBox="0 0 24 24"><g fill="${r.color}">${BULLET_SHAPES[r.shape] || BULLET_SHAPES.circle}</g>`
    + `<text x="12" y="12.6" fill="${textOn(r.color)}" font-size="${size}" font-weight="800" text-anchor="middle" dominant-baseline="middle">${esc(t)}</text></svg></span>`;
};
const min = s => `${(s / 60).toFixed(1)} min`;
const pctStr = v => `${(v * 100).toFixed(1)}%`;
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nameTag = s => `<span class="sname" data-rename="${s.id}" title="Click to rename">${esc(s.name)}</span>`;
function complexHTML(s) {
  const others = complexOf(s).filter(o => o !== s), res = G.res;
  const near = G.stations.filter(o => !complexOf(s).includes(o) && Math.hypot(o.x - s.x, o.y - s.y) < 250);
  const day = res && s.complex ? (res.complexTransfers.get(s.complex) || 0) * 2 : 0;
  return `<h4>Transfers</h4>
    ${others.length ? `<table>${others.map(o => `<tr><td>${esc(o.name)} · ${TYPES[o.type].label}${o.planned ? ' (planned)' : ''}</td><td>${TRANSFER_MIN + TRANSFER_LEVEL * Math.abs(LEVELS.indexOf(o.type) - LEVELS.indexOf(s.type))} min</td></tr>`).join('')}</table>
      <div class="kv" style="margin-top:6px"><span>Transfers here / day</span><span>${fmtInt(res ? res.transfers.get(s.id) || 0 : 0)}</span><span>Whole complex / day</span><span>${fmtInt(day)}</span></div>`
      : '<p class="note">With the Station tool, click this station to add a platform on another level as a transfer.</p>'}
    ${near.length ? `<div class="row"><button data-act="linkNearby" data-arg="${s.id}">Link ${near.length} nearby station${near.length > 1 ? 's' : ''} as a transfer</button></div>` : ''}`;
}
function stationCustom(s) {
  const cap = w => w[0].toUpperCase() + w.slice(1);
  return `<h4>Customise</h4>
    <div class="row"><button data-act="stationRot" data-arg="${s.id}:-15" title="Turn the platform">⟲ 15°</button><button data-act="stationRot" data-arg="${s.id}:15" title="Turn the platform">⟳ 15°</button></div>
    <div class="seg">${Object.entries(TYPES).map(([k, t]) => `<button class="${s.type === k ? 'on' : ''}" data-act="stationType" data-arg="${s.id}:${k}">${t.label}</button>`).join('')}</div>
    <div class="seg">${Object.entries(PLATFORMS).map(([k, L]) => `<button class="${plen(s) === L ? 'on' : ''}" data-act="stationLen" data-arg="${s.id}:${L}">${cap(k)} ${L} m<br><small>${Math.floor(L / 20)} cars</small></button>`).join('')}</div>`;
}

function catchment(x, y) {
  const C = G.city;
  let p = 0, j = 0;
  const r = Math.ceil(ACCESS_R / CELL);
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  for (let b = cj - r; b <= cj + r; b++) for (let a = ci - r; a <= ci + r; a++) {
    if (a < 0 || b < 0 || a >= C.GW || b >= C.GH) continue;
    if (Math.hypot((a + 0.5) * CELL - x, (b + 0.5) * CELL - y) > ACCESS_R) continue;
    p += C.pop[b * C.GW + a]; j += C.jobs[b * C.GW + a];
  }
  return [p, j];
}

function infoHTML() {
  const sel = UI.sel;
  if (!sel) return '';
  if (sel.kind === 'station') {
    const s = ST(sel.id);
    if (!s) return '';
    const rs = G.routes.filter(r => r.stops.includes(s.id));
    const [p, j] = catchment(s.x, s.y);
    const dest = stationDestinations(s.id).slice(0, 6);
    if (s.planned) return `<h3>${nameTag(s)} <span class="note">(planned)</span></h3>
      <div class="kv"><span>Construction</span><span>${TYPES[s.type].label}</span><span>Projected cost</span><span>${fmtMoney(s.cost)}</span>
      <span>Residents within walk</span><span>${fmtInt(p)}</span><span>Jobs within walk</span><span>${fmtInt(j)}</span></div>
      ${complexHTML(s)}
      ${stationCustom(s)}
      <div class="row"><button class="danger" data-act="demolishStation" data-arg="${s.id}">Remove from plan</button><button data-act="desel">Close</button></div>`;
    return `<h3>${nameTag(s)}</h3>
      <div class="row">${rs.map(r => `<span data-act="selRoute" data-arg="${r.id}" style="cursor:pointer">${bullet(r)}</span>`).join('') || '<span class="note">No routes stop here yet</span>'}</div>
      <div class="kv">
        <span>Construction</span><span>${TYPES[s.type].label}</span>
        <span>Daily boardings + exits</span><span>${fmtInt(G.res ? G.res.stationUse.get(s.id) || 0 : 0)}</span>
        <span>Residents within walk</span><span>${fmtInt(p)}</span>
        <span>Jobs within walk</span><span>${fmtInt(j)}</span>
      </div>
      ${dest.length ? `<h4>Top rider destinations</h4><table>${dest.map(([id, n]) => `<tr><td>${ST(id).name}</td><td>${fmtInt(n)}</td></tr>`).join('')}</table>` : ''}
      ${complexHTML(s)}
      ${stationCustom(s)}
      <div class="row"><button class="danger" data-act="demolishStation" data-arg="${s.id}">Demolish</button><button data-act="desel">Close</button></div>`;
  }
  if (sel.kind === 'junction') {
    const j = ST(sel.id);
    if (!j) return '';
    const n = G.tracks.filter(t => t.a === j.id || t.b === j.id).length;
    if (j.end) return `<h3>Track end</h3><p class="note">Keep drawing from here with the Track tool, or click it to join another track.</p><div class="row"><button class="danger" data-act="demolishStation" data-arg="${j.id}">Demolish</button><button data-act="desel">Close</button></div>`;
    return `<h3>Junction</h3><div class="kv"><span>Tracks meeting here</span><span>${n}</span></div>
      <p class="note">Trains can pass through a junction but can’t turn more than ${MAX_THROUGH}° or reverse here.</p>
      <div class="row"><button class="danger" data-act="demolishStation" data-arg="${j.id}">Demolish</button><button data-act="desel">Close</button></div>`;
  }
  if (sel.kind === 'track') {
    const t = TR(sel.id);
    if (!t) return '';
    return `<h3>Track: ${ST(t.a).name} ↔ ${ST(t.b).name}</h3>
      <div class="kv"><span>Type</span><span>${TYPES[t.type].label}</span><span>Length</span><span>${(t.len / 1000).toFixed(2)} km</span>
      <span>Maintenance</span><span>${fmtMoney(t.len / 1000 * TR_MAINT_KM)}/day</span><span>Control points</span><span>${(t.ctrl || []).length}</span></div>
      <p class="note">Drag the white control points to reshape it (Track tool, or while selected). Ctrl+click the track adds one, double-click one deletes it.</p>
      <div class="row"><button class="danger" data-act="demolishTrack" data-arg="${t.id}">Demolish</button><button data-act="desel">Close</button></div>`;
  }
  if (sel.kind === 'route') {
    const r = G.routes.find(r => r.id === sel.id);
    if (!r) return '';
    const riders = G.res ? G.res.routeRiders.get(r.id) || 0 : 0;
    const peak = r.load ? Math.max(...r.load) : 0;
    const opex = r.trains * r.cars * CAR_HOUR * 24;
    return `<h3>${bullet(r, true, 'routeStyle')} Route ${esc(r.name)}</h3>
      <div class="swatches"><button class="swatch wheel${ROUTE_COLORS.includes(r.color) ? '' : ' on'}" data-act="colorWheel" data-arg="${r.id}" title="Custom colour"></button>${ROUTE_COLORS.map(c => `<button class="swatch${c === r.color ? ' on' : ''}" style="background:${c}" data-act="color" data-arg="${c}"></button>`).join('')}</div>
      <div class="kv" style="margin-top:10px">
        <span>Trains</span><span class="stepper"><button data-act="trains-">−</button>${r.trains}<button data-act="trains+">+</button></span>
        <span>Cars per train</span><span class="stepper"><button data-act="cars-">−</button>${r.cars}<button data-act="cars+">+</button></span>
        <span>Headway</span><span>${min(r.headway)}</span>
        <span>End-to-end trip</span><span>${min(r.half - TURNAROUND)}</span>
        <span>Length · stops</span><span>${(r.length / 1000).toFixed(1)} km · ${r.stops.length}</span>
        <span>Capacity / hr / direction</span><span>${fmtInt(r.capHour)}</span>
        <span>Daily riders</span><span>${fmtInt(riders)}</span>
        <span>Peak load</span><span style="color:${loadColor(peak)}">${pctStr(peak)}</span>
        <span>Operating cost</span><span>${fmtMoney(opex)}/day</span>
      </div>
      <p class="note">Each extra train costs ${fmtMoney(r.cars * CAR_COST)}. Max ${r.maxTrains} trains (90 s headway) of up to ${routeMaxCars(r)} cars (shortest platform). Selling refunds 50%.</p>
      <div class="row"><button data-act="editRoute">Edit stops</button><button class="danger" data-act="deleteRoute">Delete route</button><button data-act="desel">Close</button></div>
      <h4>Stops</h4><ol class="stops">${r.stops.map(id => `<li>${ST(id).name}</li>`).join('')}</ol>`;
  }
  return '';
}

function chart(vals, color) {
  if (vals.length < 2) return '<svg class="chart"></svg><div class="note">Charts appear after a few in-game days.</div>';
  const mx = Math.max(...vals), mn = Math.min(0, ...vals), rng = mx - mn || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 300).toFixed(1)},${(85 - (v - mn) / rng * 80).toFixed(1)}`).join(' ');
  const zero = 85 - (0 - mn) / rng * 80;
  return `<svg class="chart" viewBox="0 0 300 90" preserveAspectRatio="none"><line x1="0" x2="300" y1="${zero}" y2="${zero}" stroke="#333b47"/><polyline fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}

function bodyHTML() {
  const res = G.res;
  if (UI.tab === 'routes') {
    const d = UI.routeDraft;
    let h = '';
    if (d) {
      h += `<h3>${bullet({ color: d.color, name: d.editing ? d.name : '+', shape: d.editing && G.routes.find(r => r.id === d.editing).shape })}${d.editing ? 'Editing route ' + esc(d.name) : 'New route'}</h3>
        <p class="note">Click stations in order along built track. Stations passed on the way become stops; <b>Shift+click</b> to skip them (express).</p>
        <div class="kv"><span>Stops</span><span>${d.stops.length}</span><span>Length</span><span>${(d.legs.reduce((s, l) => s + polyLen(legPoints(l)), 0) / 1000).toFixed(1)} km</span></div>
        <div class="row"><button class="primary" data-act="finishDraft" ${d.stops.length < 2 ? 'disabled' : ''}>${d.editing ? 'Save route' : 'Open route'} ⏎</button>
        <button data-act="undoDraft" ${d.stops.length ? '' : 'disabled'}>Undo ⌫</button><button data-act="reverseDraft" ${d.stops.length > 1 ? '' : 'disabled'}>Reverse</button><button data-act="cancelDraft">Cancel</button></div>
        <ol class="stops">${d.stops.map(id => `<li>${ST(id).name}</li>`).join('')}</ol>`;
    } else h += `<div class="row"><button class="primary" data-act="newRoute">+ New route</button></div>`;
    if (!G.routes.length && !d) h += `<p class="note">No routes yet. Build stations and track, then create a route to run trains on them.</p>`;
    h += '<div class="rlist">' + G.routes.map(r => {
      const riders = res ? res.routeRiders.get(r.id) || 0 : 0;
      const peak = r.load ? Math.max(...r.load) : 0;
      return `<div class="ritem${UI.sel && UI.sel.id === r.id ? ' on' : ''}" data-act="selRoute" data-arg="${r.id}">${bullet(r)}
        <div class="grow"><b>${ST(r.stops[0]).name} – ${ST(r.stops[r.stops.length - 1]).name}</b>
        <small>${r.stops.length} stops · ${r.trains} trains · every ${min(r.headway)} · ${fmtInt(riders)}/day</small>
        <div class="bar"><i style="width:${Math.min(100, peak * 100)}%;background:${loadColor(peak)}"></i></div></div></div>`;
    }).join('') + '</div>';
    return h;
  }
  if (UI.tab === 'stats') {
    if (!res) return '<p class="note">Simulating…</p>';
    const T = res.total || 1;
    const top = G.stations.map(s => [s, res.stationUse.get(s.id) || 0]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const modebar = (n, v, c) => `<span>${n}</span><span>${pctStr(v / T)}</span><div class="bar" style="grid-column:1/-1"><i style="width:${v / T * 100}%;background:${c}"></i></div>`;
    return `<h4>Commute mode share</h4><div class="kv">${modebar('Subway', res.transit, '#3b82f6')}${modebar('Car', res.car, '#e6a23c')}${modebar('Walk', res.walk, '#2fbf71')}</div>
      <div class="kv" style="margin-top:10px">
        <span>Daily subway trips</span><span>${fmtInt(res.trips)}</span>
        <span>Commuters near a station</span><span>${pctStr(res.served / T)}</span>
        <span>Total commuters</span><span>${fmtInt(T)}</span>
        <span>Stations · routes</span><span>${builtStations().length} · ${G.routes.length}</span>
        <span>Track built</span><span>${trackKm().toFixed(1)} km</span>
        <span>Trains · cars</span><span>${G.routes.reduce((s, r) => s + r.trains, 0)} · ${totalCars()}</span>
      </div>
      <h4>Daily riders</h4>${chart(G.history.map(h => h.trips), '#3b82f6')}
      <h4>Funds</h4>${chart(G.history.map(h => h.money), '#2fbf71')}
      <h4>Busiest stations</h4><table>${top.map(([s, n]) => `<tr><td>${s.name}</td><td>${fmtInt(n)}</td></tr>`).join('') || '<tr><td class="note">No stations yet</td></tr>'}</table>`;
  }
  if (UI.tab === 'finance') {
    const L = G.lastDay, t = G.today;
    const est = (res ? res.trips : 0) * G.fare;
    const opex = dailyOpex();
    const day = (d) => `<div class="kv">
      <span>Fare revenue</span><span>${fmtMoney(d.fares)}</span><span>Grants</span><span>${fmtMoney(d.rewards)}</span>
      <span>Train operations</span><span>-${fmtMoney(d.ops)}</span><span>Maintenance</span><span>-${fmtMoney(d.maint)}</span>
      <span>Bond payments</span><span>-${fmtMoney(d.interest)}</span>
      <span class="total">Operating result</span><span class="total" style="color:${d.fares + d.rewards - d.ops - d.maint - d.interest >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMoney(d.fares + d.rewards - d.ops - d.maint - d.interest)}</span>
      <span>Construction</span><span>-${fmtMoney(d.construction)}</span><span>Rolling stock</span><span>-${fmtMoney(d.trains)}</span></div>`;
    return `<div class="kv"><span>Funds</span><span style="color:${G.money < 0 ? 'var(--bad)' : 'inherit'}">${fmtMoney(G.money)}</span>
        <span>Estimated daily fares</span><span>${fmtMoney(est)}</span><span>Estimated daily opex</span><span>-${fmtMoney(opex)}</span>
        <span class="total">Estimated daily operating result</span><span class="total" style="color:${est - opex >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMoney(est - opex)}</span></div>
      <h4>Today so far</h4>${day(t)}
      ${L ? `<h4>Yesterday</h4>${day(L)}` : ''}
      <h4>Bonds</h4>
      ${G.bonds.map((b, i) => `<div class="row"><span class="grow">${fmtMoney(b.bal)} left · ${fmtMoney(b.pay)}/day</span><button data-act="repay" data-arg="${i}">Repay</button></div>`).join('') || '<p class="note">No outstanding bonds.</p>'}
      <div class="row"><button data-act="bond" ${G.bonds.length >= MAX_BONDS ? 'disabled' : ''}>Issue ${fmtMoney(BOND)} bond</button></div>
      <p class="note">${(BOND_RATE * 100).toFixed(1)}% interest, repaid daily over ${BOND_DAYS / 365} years. Up to ${MAX_BONDS} outstanding.</p>
      <h4>Unit costs</h4><div class="kv">${Object.values(TYPES).map(t => `<span>${t.label}</span><span>${fmtMoney(t.km)}/km · ${fmtMoney(t.station)}/stn</span>`).join('')}
      <span>Train car</span><span>${fmtMoney(CAR_COST)} + ${fmtMoney(CAR_HOUR)}/hr</span></div>`;
  }
  if (UI.tab === 'goals') {
    const n = GOALS.filter(g => G.goals[g.id]).length;
    return `<p class="note">${n} of ${GOALS.length} complete. Goals pay out a city grant when reached (checked at the end of each day).</p>` +
      GOALS.map(g => `<div class="goal${G.goals[g.id] ? ' done' : ''}"><span class="ck">${G.goals[g.id] ? '✔' : '○'}</span><span class="txt">${g.text}</span><span class="rw">${fmtMoney(g.reward)}</span></div>`).join('');
  }
  return '';
}

let lastInfo = '', lastBody = '', lastPlan = '';
// drop references to pieces removed meanwhile (demolished from the panel, merged back by Discard, route deleted);
// called by draw() and refreshUI(), which would otherwise throw on them
function pruneUI() {
  const d = UI.routeDraft;
  if (d && (d.stops.some(id => !ST(id)) || d.legs.some(l => l.some(p => !TR(p.t))) || (d.editing && !G.routes.some(r => r.id === d.editing)))) {
    UI.routeDraft = null;
    toast('Route draft cancelled — part of it was removed', true);
  }
  if (UI.from && (UI.from.id ? !ST(UI.from.id) : UI.from.track && !G.tracks.includes(UI.from.track))) { UI.from = null; UI.ctrl = []; UI.curveCtrl = null; }
  if (UI.transferOf && !ST(UI.transferOf)) UI.stationAt = UI.transferOf = null;
}
function refreshUI() {
  if (!G) return;
  pruneUI();
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === UI.tool));
  document.querySelectorAll('[data-build]').forEach(b => b.classList.toggle('on', b.dataset.build === UI.build));
  document.querySelectorAll('[data-overlay]').forEach(b => b.classList.toggle('on', b.dataset.overlay === UI.overlay));
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', UI.panelOpen && b.dataset.tab === UI.tab));
  $('panel').classList.toggle('collapsed', !UI.panelOpen);
  document.querySelectorAll('[data-gfx]').forEach(b => b.classList.toggle('on', !!GFX[b.dataset.gfx]));
  document.querySelectorAll('[data-follow]').forEach(b => b.classList.toggle('on', UI.followRoads));
  document.querySelectorAll('[data-plan]').forEach(b => b.classList.toggle('on', UI.plan));
  document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === UI.shape));
  const n = planItems().length, total = planTotal();
  const plan = !UI.plan && !n ? '' : `<b>Plan mode${UI.plan ? '' : ' (off)'}</b>
    <span>${n ? `${n} planned piece${n > 1 ? 's' : ''} · projected <b>${fmtMoney(total)}</b>` : 'Place stations and track to see the projected cost'}</span>
    ${total > G.money ? '<span class="bad">Not enough money</span>' : ''}
    ${n ? `<button class="primary" data-act="commitPlan" ${total > G.money ? 'disabled' : ''}>Build ⏎</button><button data-act="discardPlan">Discard</button>` : ''}`;
  if (plan !== lastPlan) { $('planbar').innerHTML = plan; lastPlan = plan; }
  const info = infoHTML(), body = UI.panelOpen ? bodyHTML() : '';
  const editing = document.activeElement && document.activeElement.tagName === 'INPUT' && $('info').contains(document.activeElement);
  if (!editing && info !== lastInfo) { $('info').innerHTML = info; lastInfo = info; }   // don't wipe a name being typed
  if (body !== lastBody) { $('panelBody').innerHTML = body; lastBody = body; }
  const legends = {
    pop: '<i style="background:#e86028"></i>Residents per block',
    jobs: '<i style="background:#465ae1"></i>Jobs per block',
    demand: '<i style="background:#9a5ac8"></i>Unserved &nbsp;<i style="background:#1ec850"></i>Uses subway<br>Line width = commuters (Census LODES)',
    ridership: '<i style="background:#2fbf71"></i>&lt;50% <i style="background:#e6c229"></i>&lt;80% <i style="background:#f08a24"></i>&lt;100% <i style="background:#e0302b"></i>Over capacity',
    transit: '<i style="background:#d6281f"></i>Subway <i style="background:#1f8f3a"></i>Light rail<br><i style="background:#41556b"></i>Rail &nbsp;○ Stations (OpenStreetMap)',
  };
  $('legend').innerHTML = legends[UI.overlay] || '';
  applyOverlayLayers();
  const hints = {
    select: UI.overlay === 'transit' ? 'Click a <b>real station or line</b> to add it to your plan. Click your own pieces to inspect them.' : 'Click a station, track or route to inspect it. Drag to pan, scroll to zoom.',
    station: UI.stationAt ? `Move the mouse to turn the platform, click to place the <b>${TYPES[UI.build].label}</b> ${UI.transferOf ? `transfer platform at <b>${esc(ST(UI.transferOf).name)}</b>` : 'station'}. <b>↑/↓</b> level, <b>right-click</b> cancel.`
      : `Click to set the centre of a <b>${TYPES[UI.build].label}</b> station, click existing track to insert one, or click a <b>station</b> to add a transfer platform. <b>↑/↓</b> level.`,
    track: (!UI.from ? 'Click a station, track end, open ground, or <b>existing track to branch off it</b> to start a track.'
      : UI.shape === 'curve' ? (UI.curveCtrl ? 'Click where the curve ends.' : 'Click the curve’s bend point.')
      : UI.shape === 'free' ? 'Freeform: the track bends smoothly out of the last piece — click where it ends.'
      : `Click to add control points${UI.followRoads ? ' (following streets)' : ''}. <b>Double-click</b> or <b>Enter</b> ends the track; click a station, track end or track to join it. <b>Backspace</b> removes a point.`)
      + ` <b>${TYPES[UI.build].label}</b> (↑/↓) · <b>T</b> shape · <b>R</b> follow roads · <b>right-click</b> cancel.`,
    route: UI.routeDraft ? 'Click the next station. <b>Enter</b> to finish, <b>Backspace</b> to undo, <b>Esc</b> to cancel.' : 'Click a station to start a new route.',
    demolish: 'Click an unused station or track to demolish it (no refund).',
  };
  $('hint').innerHTML = hints[UI.tool];
}

function updateTopbar() {
  if (!G) return;
  $('clock').textContent = clockStr();
  const m = $('money');
  m.textContent = fmtMoney(G.money);
  m.classList.toggle('neg', G.money < 0);
  $('riders').textContent = G.res ? fmtInt(G.res.trips) : '…';
  $('share').textContent = G.res ? pctStr(G.res.transit / G.res.total) : '…';
  document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === G.speed));
}

function doAction(act, arg, el) {
  const r = UI.sel && UI.sel.kind === 'route' ? G.routes.find(r => r.id === UI.sel.id) : null;
  switch (act) {
    case 'newRoute': startRouteDraft(null); break;
    case 'finishDraft': finishDraft(); break;
    case 'undoDraft': undoDraft(); break;
    case 'reverseDraft': reverseDraft(); break;
    case 'cancelDraft': UI.routeDraft = null; UI.tool = 'select'; break;
    case 'selRoute': UI.sel = { kind: 'route', id: +arg }; break;
    case 'desel': UI.sel = null; break;
    case 'color': if (r) { r.color = arg; G.version++; } break;
    case 'colorWheel': if (r) openColorWheel(r, el); break;
    case 'routeStyle': if (r) openRouteStyle(r, el); break;
    case 'trains+': if (r) setTrains(r, r.trains + 1); break;
    case 'trains-': if (r) setTrains(r, r.trains - 1); break;
    case 'cars+': if (r) setCars(r, r.cars + 1); break;
    case 'cars-': if (r) setCars(r, r.cars - 1); break;
    case 'editRoute': if (r) startRouteDraft(r); break;
    case 'deleteRoute': if (r && confirm(`Delete route ${r.name}? Trains are sold at 50%.`)) { deleteRoute(r); UI.sel = null; } break;
    case 'demolishStation': if (demolishStation(ST(+arg))) UI.sel = null; break;
    case 'demolishTrack': if (demolishTrack(TR(+arg))) UI.sel = null; break;
    case 'bond': takeBond(); break;
    case 'commitPlan': commitPlan(); break;
    case 'discardPlan': discardPlan(); UI.from = null; UI.ctrl = []; UI.sel = null; toast('Plan discarded'); break;
    case 'linkNearby': { const st = ST(+arg), near = linkNearby(st); if (near.length) toast(`${st.name} now transfers with ${[...new Set(near.map(o => o.name))].join(', ')}`); break; }
    case 'stationType': { const [id, ty] = arg.split(':'); restyleStation(ST(+id), { type: ty }); break; }
    case 'stationLen': { const [id, L] = arg.split(':'); restyleStation(ST(+id), { plen: +L }); break; }
    case 'stationRot': { const [id, deg] = arg.split(':'), st = ST(+id); restyleStation(st, { ang: (st.ang || 0) + deg * Math.PI / 180 }); break; }
    case 'repay': repayBond(+arg); break;
  }
  refreshUI();
}

// ---------- menu
function showMenu() {
  UI.menuOpen = true;
  $('menu').classList.remove('hidden');
  $('btnResume').classList.toggle('hidden', !G);
  $('cities').innerHTML = CITY_LIST.map(c => `<div class="ccard"><h2>${c.name}</h2>
    <p>Real streets, water and buildings from OpenStreetMap. Commuters from US Census LODES home→work data.</p>
    <div class="row"><button class="primary" data-new="${c.id}">New game</button>${hasSave(c.id) ? `<button data-load="${c.id}">Continue</button>` : ''}</div></div>`).join('');
}
function startGame(id, load) {
  if (G) saveGame(true);
  $('cities').innerHTML = '<p class="note">Loading census data and map…</p>';
  return loadCityData(id).then(data => {
    if (!(load && loadGame(data))) {
      if (load) toast('Save could not be loaded — starting fresh', true);
      newGame(data);
    }
    UI.sel = null; UI.routeDraft = null; UI.from = null; UI.ctrl = []; UI.tool = 'select';
    initMap(G.city, G.cam);
    wireMap();
    $('cityName').textContent = G.city.name;
    $('fare').value = G.fare.toFixed(2);
    $('menu').classList.add('hidden');
    UI.menuOpen = false;
    lastInfo = lastBody = null;
    refreshUI();
    let seen = true;
    try { seen = !!localStorage.getItem('subwaybuilder:helpSeen'); localStorage.setItem('subwaybuilder:helpSeen', '1'); } catch (e) { }
    if (!load && !seen) $('help').classList.remove('hidden');
  }).catch(e => { toast(e.message, true); showMenu(); });
}

// ---------- wiring
$('buildTypes').innerHTML = Object.entries(TYPES).map(([k, t]) =>
  `<button class="bt" data-build="${k}" title="${t.desc}"><span style="display:flex;width:100%">${t.label}<kbd>${t.key}</kbd></span><small>${fmtMoney(t.km)}/km · ${fmtMoney(t.station)}/stn</small></button>`).join('');

// pointerdown, not click: panels re-render twice a second and would swallow clicks
// ---------- popovers: small floating editors beside the panel (they live outside it, so panel refreshes leave them alone)
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
const rgbHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return [f(5), f(3), f(1)];
}
function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const h = !d ? 0 : mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, mx ? d / mx : 0, mx];
}
let popOpener = null;
function closePopover() {
  if ($('popover').classList.contains('hidden')) return false;
  $('popover').classList.add('hidden'); popOpener = null; lastInfo = null; refreshUI();
  return true;
}
function openPopover(anchor, html) {
  const p = $('popover');
  if (popOpener === anchor) { closePopover(); return null; }   // clicking the opener again closes it
  p.innerHTML = html; p.classList.remove('hidden'); popOpener = anchor;
  const a = anchor.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = Math.max(8, a.left - w - 12) + 'px';
  p.style.top = Math.max(60, Math.min(innerHeight - h - 8, a.top - 10)) + 'px';
  return p;
}
document.addEventListener('pointerdown', e => {
  if (!$('popover').contains(e.target) && !(popOpener && popOpener.contains(e.target))) closePopover();
}, true);
// colour wheel: hue around, saturation outwards, brightness slider, hex box
function openColorWheel(r, anchor) {
  const p = openPopover(anchor, `<div class="ptitle">Route colour</div><canvas class="wheel" width="200" height="200"></canvas>
    <label class="prow">Brightness <input type="range" class="val" min="5" max="100"></label>
    <div class="prow"><span class="pswatch"></span><input class="hex" maxlength="7" spellcheck="false"><button class="primary" data-pop="done">Done</button></div>`);
  if (!p) return;
  const cv = p.querySelector('canvas'), g = cv.getContext('2d'), R = 100, val = p.querySelector('.val'), hex = p.querySelector('.hex');
  let [hu, sa, va] = rgb2hsv(hexRgb(r.color));
  const draw = () => {
    const img = g.createImageData(200, 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
      const dx = x - R, dy = y - R, d = Math.hypot(dx, dy), i = (y * 200 + x) * 4;
      if (d > R) continue;
      const [cr, cg, cb] = hsv2rgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / R, va);
      img.data.set([cr, cg, cb, d > R - 1 ? (R - d) * 255 : 255], i);
    }
    g.putImageData(img, 0, 0);
    const mx = R + Math.cos(hu * Math.PI / 180) * sa * R, my = R + Math.sin(hu * Math.PI / 180) * sa * R;
    g.beginPath(); g.arc(mx, my, 6, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
  };
  const apply = (redraw = true) => {
    r.color = rgbHex(hsv2rgb(hu, sa, va)); G.version++;
    p.querySelector('.pswatch').style.background = r.color;
    if (document.activeElement !== hex) hex.value = r.color;
    if (redraw) draw();
  };
  const pick = e => {
    const b = cv.getBoundingClientRect(), dx = e.clientX - b.left - R, dy = e.clientY - b.top - R;
    hu = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; sa = Math.min(1, Math.hypot(dx, dy) / R);
    apply();
  };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pick(e); });
  cv.addEventListener('pointermove', e => { if (e.buttons) pick(e); });
  val.value = Math.round(va * 100);
  val.addEventListener('input', () => { va = val.value / 100; apply(); });
  hex.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); if (e.key === 'Escape') closePopover(); });
  hex.addEventListener('change', () => {
    if (!/^#?[0-9a-f]{6}$/i.test(hex.value.trim())) { hex.value = r.color; return; }
    [hu, sa, va] = rgb2hsv(hexRgb('#' + hex.value.trim().replace('#', '')));
    val.value = Math.round(va * 100); apply();
  });
  p.querySelector('[data-pop="done"]').addEventListener('click', closePopover);
  apply();
}
// bullet style: shape and the symbol on it
const BULLET_SYMBOLS = [...'123456789', 'X', 'S', 'L', '★', '●', '▲', '◆', '✚', '✦', '♥', '♣', '∞', 'Ω', 'λ', 'Σ'];
function openRouteStyle(r, anchor) {
  const p = openPopover(anchor, `<div class="ptitle">Route bullet</div>
    <div class="pgrid shapes4">${Object.keys(BULLET_SHAPES).map(k => `<button data-shape-pick="${k}" title="${k}">${bullet({ ...r, shape: k })}</button>`).join('')}</div>
    <label class="prow">Symbol <input class="sym" maxlength="3" spellcheck="false" value="${esc(r.name)}"></label>
    <div class="pgrid syms">${BULLET_SYMBOLS.map(c => `<button data-sym="${esc(c)}">${esc(c)}</button>`).join('')}</div>`);
  if (!p) return;
  const sym = p.querySelector('.sym');
  const refresh = () => { G.version++; lastInfo = null; refreshUI(); p.querySelectorAll('[data-shape-pick]').forEach(b => { b.classList.toggle('on', (r.shape || 'circle') === b.dataset.shapePick); b.innerHTML = bullet({ ...r, shape: b.dataset.shapePick }); }); };
  p.addEventListener('pointerdown', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.shapePick) r.shape = b.dataset.shapePick;
    if (b.dataset.sym) { r.name = b.dataset.sym; sym.value = r.name; }
    refresh();
  });
  sym.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') closePopover(); });
  sym.addEventListener('input', () => { if (sym.value.trim()) { r.name = sym.value.trim(); refresh(); } });
  refresh();
}

// click a station's name in the panel to edit it in place
function startRename(el) {
  const s = ST(+el.dataset.rename);
  if (!s) return;
  const inp = document.createElement('input');
  Object.assign(inp, { className: 'rename', value: s.name, maxLength: 60 });
  el.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = keep => { if (done) return; done = true; if (keep) renameStation(s, inp.value); inp.blur(); lastInfo = null; refreshUI(); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}
document.addEventListener('pointerdown', e => {
  const rn = e.button === 0 && e.target.closest('[data-rename]');
  if (rn) { e.preventDefault(); startRename(rn); return; }
  const b = e.button === 0 && e.target.closest('button, [data-act]');
  if (!b || b.disabled || !b.closest('#toolbar, #panel, #topbar, #menu, #planbar')) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.build) { UI.build = b.dataset.build; refreshUI(); }
  else if (b.dataset.overlay) { UI.overlay = b.dataset.overlay; refreshUI(); }
  else if (b.dataset.gfx) { setGfx(b.dataset.gfx, !GFX[b.dataset.gfx]); refreshUI(); }
  else if ('follow' in b.dataset) { UI.followRoads = !UI.followRoads; refreshUI(); }
  else if ('plan' in b.dataset) { UI.plan = !UI.plan; refreshUI(); }
  else if (b.dataset.shape) { UI.shape = b.dataset.shape; UI.curveCtrl = null; refreshUI(); }
  else if (b.dataset.tab) { UI.panelOpen = !(UI.panelOpen && UI.tab === b.dataset.tab); UI.tab = b.dataset.tab; refreshUI(); }   // same tab again folds it
  else if (b.dataset.speed) { G.speed = +b.dataset.speed; }
  else if (b.dataset.new) startGame(b.dataset.new, false);
  else if (b.dataset.load) startGame(b.dataset.load, true);
  else if (b.dataset.act) doAction(b.dataset.act, b.dataset.arg, b);
});
$('btnSave').onclick = () => saveGame(false);
$('btnMenu').onclick = () => { saveGame(true); showMenu(); };
$('btnResume').onclick = () => { $('menu').classList.add('hidden'); UI.menuOpen = false; };
$('btnHelp').onclick = () => $('help').classList.remove('hidden');
$('btnHelpClose').onclick = () => $('help').classList.add('hidden');
$('fare').addEventListener('change', e => {
  const v = Math.max(0, Math.min(10, +e.target.value || 0));
  G.fare = v; e.target.value = v.toFixed(2); markDirty();
});

function wireMap() {
  let rdown = null;
  map.on('click', e => onMapClick(e.point.x, e.point.y, e.originalEvent.shiftKey, e.originalEvent.ctrlKey || e.originalEvent.metaKey));
  map.on('mousemove', e => {
    UI.mouse.x = e.point.x; UI.mouse.y = e.point.y; UI.mouse.shift = e.originalEvent.shiftKey; UI.mouse.in = true;
    if (UI.drag) { const c = UI.drag.ctrl[UI.drag.i], [x, y] = Wpt(e.point.x, e.point.y); UI.drag.ctrl[UI.drag.i] = [x, y, c[2]]; UI.drag.moved = true; }
    UI.hover = hitTest(e.point.x, e.point.y);
    map.getCanvas().style.cursor = handleAt(e.point.x, e.point.y) ? 'move' : UI.tool === 'select' ? (UI.hover ? 'pointer' : '') : 'crosshair';
  });
  map.on('mouseout', () => { UI.mouse.in = false; UI.hover = null; });
  map.on('mousedown', e => {
    UI.handleClick = false;
    if (e.originalEvent.button === 2) { rdown = [e.point.x, e.point.y]; return; }
    const h = e.originalEvent.button === 0 && handleAt(e.point.x, e.point.y);
    if (!h) return;
    UI.handleClick = true;   // grab a control point instead of panning
    UI.drag = { t: h.t, i: h.i, ctrl: TR(h.t).ctrl.map(c => c.slice()), moved: false };
    map.dragPan.disable();
  });
  map.on('dblclick', e => {
    const h = handleAt(e.point.x, e.point.y);
    if (h) { const t = TR(h.t); editTrack(t, t.ctrl.filter((_, k) => k !== h.i)); refreshUI(); return; }
    if (UI.tool === 'track' && UI.from && UI.shape === 'straight' && UI.ctrl.length) {
      const n = UI.ctrl.length;   // both clicks of the double-click added a point: keep one, end the track there
      if (n > 1 && Math.hypot(UI.ctrl[n - 1][0] - UI.ctrl[n - 2][0], UI.ctrl[n - 1][1] - UI.ctrl[n - 2][1]) < 15) UI.ctrl.pop();
      endTrackHere(); refreshUI();
    }
  });
  // right-click cancels (placing a station, drawing track, …); right-drag still rotates/tilts the camera
  map.on('contextmenu', e => { if (rdown && Math.hypot(e.point.x - rdown[0], e.point.y - rdown[1]) < 5) cancelAction(); rdown = null; });
}
window.addEventListener('mouseup', () => {
  if (!UI.drag) return;
  const d = UI.drag;
  UI.drag = null;
  map.dragPan.enable();
  if (d.moved) editTrack(TR(d.t), d.ctrl);
  refreshUI();
});

window.addEventListener('keydown', e => {
  if (!G || UI.menuOpen || e.target.tagName === 'INPUT') return;
  const k = e.key;
  const tools = { 1: 'select', 2: 'station', 3: 'track', 4: 'route', 5: 'demolish' };
  if (tools[k]) setTool(tools[k]);
  else if (k === ' ') { e.preventDefault(); G.speed = G.speed ? 0 : (UI.lastSpeed || 1); if (G.speed) UI.lastSpeed = G.speed; }
  else if (k === '[') G.speed = Math.max(0, G.speed - 1);
  else if (k === ']') G.speed = Math.min(SPEEDS.length - 1, G.speed + 1);
  else if (k === 'Escape') { if (!closePopover()) cancelAction(); }
  else if (k === 'r' || k === 'R') { UI.followRoads = !UI.followRoads; refreshUI(); }
  else if (k === 'Enter' && UI.routeDraft) finishDraft();
  else if (k === 'Enter' && UI.tool === 'track' && UI.from && UI.ctrl.length) { endTrackHere(); refreshUI(); }
  else if (k === 'Enter' && planItems().length) { commitPlan(); refreshUI(); }
  else if (k === 'b' || k === 'B') { UI.plan = !UI.plan; refreshUI(); }
  else if (k === 't' || k === 'T') { UI.shape = SHAPES[(SHAPES.indexOf(UI.shape) + 1) % SHAPES.length]; UI.curveCtrl = null; refreshUI(); }
  else if (k === 'Backspace') {
    e.preventDefault();
    if (UI.routeDraft) undoDraft(); else if (UI.curveCtrl) UI.curveCtrl = null; else if (UI.ctrl.length) UI.ctrl.pop();
    refreshUI();
  } else {
    const t = Object.entries(TYPES).find(([, t]) => t.key.toLowerCase() === k.toLowerCase());
    if (t) { UI.build = t[0]; refreshUI(); }
  }
  if (G.speed) UI.lastSpeed = G.speed;
});
// ↑ / ↓ step the construction elevation; captured first so the map doesn't pan
window.addEventListener('keydown', e => {
  if (!G || UI.menuOpen || e.target.tagName === 'INPUT' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault(); e.stopPropagation();
  const i = ELEVATIONS.indexOf(UI.build) + (e.key === 'ArrowUp' ? 1 : -1);
  if (i < 0 || i >= ELEVATIONS.length) return;
  UI.build = ELEVATIONS[i];
  toast(`Elevation: ${TYPES[UI.build].label}`);
  refreshUI();
}, true);
window.addEventListener('beforeunload', () => saveGame(true));
// any input may change hover, previews or selection: redraw the overlay on the next frame
for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'pointerout', 'keydown', 'keyup', 'wheel']) window.addEventListener(ev, () => { needsDraw = true; }, true);

// ---------- main loop
let lastT = performance.now(), lastPanel = 0;
function frame(now) {
  requestAnimationFrame(frame);   // first: an exception below must not stop the game (it froze the overlay until reload)
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (G) {
    if (!UI.menuOpen) tick(dt);
    // ponytail: _frameRequest is MapLibre-internal (4.7): a map frame is pending and its render event will draw;
    // without the check frames where the map renders draw twice
    if (overlayStale() && !(map && map._frameRequest)) draw();
    updateTopbar();
    if (now - lastPanel > 500) { lastPanel = now; refreshUI(); }
  }
}
resize();
const autoCity = new URLSearchParams(location.search).get('city');
if (autoCity && CITY_LIST.some(c => c.id === autoCity)) startGame(autoCity, hasSave(autoCity)); else showMenu();
requestAnimationFrame(frame);
