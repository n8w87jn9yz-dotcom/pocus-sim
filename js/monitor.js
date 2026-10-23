import { VERT, FRAG } from './shader.js';
import {
  PROBES, WINDOWS, FINDINGS, SCENARIOS, TISSUES,
  matFromQuat, qNlerp, probeMatrix, matMul, rotX, rotY, rotZ,
} from './common.js';
import { WebcamTracker } from './webcam.js';
import { Anatomy3D } from './anatomy3d.js';

const state = {
  probe: 'convex', win: 0, depth: PROBES.convex.def, gain: 1.0,
  frozen: false, cases: 0, hidden: false,
  slide: [0, 0],
  track: null, trackInfo: '', bodyScale: 100,
  anat: 'off', tint: false, fan: true, note: '',
};
let tracker = null;
const pose = { target: null, q: null, Rn: null, mouse: { rock: 0, fan: 0, rot: 0 }, source: 'mouse' };
let conn = null;
let time = 0;

const $ = id => document.getElementById(id);
const usCanvas = $('us'), overlay = $('overlay'), anatCanvas = $('anat');
const anat3d = new Anatomy3D($('anat3d'));

// ---------- WebGL ----------
const gl = usCanvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
if (!gl) document.body.innerHTML = '<p class="fatal">Dieser Browser unterstützt kein WebGL2.</p>';

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
const U = {};
for (const n of ['uRes', 'uDepth', 'uGain', 'uTime', 'uTop', 'uProbe', 'uWin', 'uCase', 'uOrigin', 'uRot', 'uVol', 'uDims', 'uSpacing', 'uDebug', 'uTint']) U[n] = gl.getUniformLocation(prog, n);

// Interne Auflösung bewusst niedrig, das Bild wird per CSS skaliert (?h=300 für schwache Rechner)
const DEBUG = new URLSearchParams(location.search).has('debug');
const RENDER_H = +new URLSearchParams(location.search).get('h') || 460;
function resize() {
  const wrap = $('usWrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const scale = RENDER_H / h;
  usCanvas.width = Math.round(w * scale);
  usCanvas.height = RENDER_H;
  const dpr = window.devicePixelRatio || 1;
  overlay.width = anatCanvas.width = Math.round(w * dpr);
  overlay.height = anatCanvas.height = Math.round(h * dpr);
}
window.addEventListener('resize', resize);

function topOffset() { return state.probe === 'convex' ? 0.9 : 0.15; }

function currentMatrix() {
  if (pose.source === 'phone' && pose.q) {
    if (!pose.Rn) pose.Rn = matFromQuat(pose.q);
    return probeMatrix(pose.Rn, matFromQuat(pose.q));
  }
  const m = pose.mouse;
  return matMul(matMul(rotY(m.rot), rotX(m.fan)), rotZ(m.rock));
}

// ---------- CT-Volumen ----------
const volumes = {};
let loadingVol = null;

async function fetchVolume(name) {
  const meta = await (await fetch(`data/${name}/meta.json`)).json();
  let buf = new Uint8Array(await (await fetch(`data/${name}/vol.bin.gz`)).arrayBuffer());
  // Manche Server entpacken .gz bereits selbst, dann fehlt die gzip-Signatur
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const [dx, dy, dz] = meta.dims;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8UI, dx, dy, dz, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, buf);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
  return { meta, data: buf, tex };
}

function currentVolume() {
  const name = WINDOWS[state.win].vol;
  if (volumes[name]) return volumes[name];
  if (loadingVol !== name) {
    loadingVol = name;
    $('loading').hidden = false;
    fetchVolume(name)
      .then(v => { volumes[name] = v; $('loading').hidden = true; })
      .catch(err => { $('loading').textContent = `CT konnte nicht geladen werden: ${err.message}`; });
  }
  return null;
}

function classAt(vol, p) {
  const [dx, dy, dz] = vol.meta.dims, s = vol.meta.spacing;
  const x = Math.floor(p[0] / s), y = Math.floor(p[1] / s), z = Math.floor(p[2] / s);
  if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return 0;
  return vol.data[4 * (x + dx * (y + dy * z))];
}

// Sondenursprung: Fensterpunkt plus Verschiebung, dann zurück auf die Haut gelegt
function probeOrigin(vol, w) {
  const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
  // Kamera-Tracking (mm am Übungsobjekt) auf die Größe des CT-Körpers umrechnen
  const [ol, oe] = offsetMm();
  let p = add(add(w.origin, w.L, ol), w.E, oe);
  // von außen entlang der Schallrichtung bis zur Haut laufen
  const start = add(p, w.D, -80);
  for (let i = 0; i < 200; i++) {
    const q = add(start, w.D, i);
    if (classAt(vol, q) !== 0) return q;
  }
  return p;
}

// Verschiebung (mm) im Fenstersystem: Pfeiltasten und Webcam, umgerechnet auf die Größe des CT-Körpers
function offsetMm() {
  const k = 100 / state.bodyScale;
  const t = state.track || [0, 0, 0];
  return [state.slide[0] * 10 + t[0] * k, state.slide[1] * 10 + t[2] * k];
}

let lastM = currentMatrix();
function render() {
  gl.viewport(0, 0, usCanvas.width, usCanvas.height);
  const vol = currentVolume();
  if (!vol) {
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (state.anat === 'cut') anatCanvas.getContext('2d').clearRect(0, 0, anatCanvas.width, anatCanvas.height);
    return;
  }
  const w = vol.meta.windows[WINDOWS[state.win].key];
  const B = [0, 1, 2].map(r => [w.L[r], w.D[r], w.E[r]]);
  const M = matMul(B, lastM);
  const o = probeOrigin(vol, w);
  const labels = (state.anat === 'cut' || state.tint) ? sampleLabels(vol, M, o) : null;
  if (state.anat === 'cut') {
    drawPass(vol, M, o, 1);
    const ctx = anatCanvas.getContext('2d');
    ctx.drawImage(usCanvas, 0, 0, anatCanvas.width, anatCanvas.height);
    drawLabels(ctx, labels.all, anatCanvas.width, anatCanvas.height);
  }
  drawPass(vol, M, o, DEBUG ? 1 : 0);
  if (state.anat === 'body') draw3D(vol, M, o);
  drawOverlay(lastM);
  if (state.tint) drawLabels(overlay.getContext('2d'), labels.fan, overlay.width, overlay.height);
}

function drawPass(vol, M, o, debug) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, vol.tex);
  gl.uniform1i(U.uVol, 0);
  gl.uniform3f(U.uDims, ...vol.meta.dims);
  gl.uniform1f(U.uSpacing, vol.meta.spacing);
  gl.uniform1i(U.uDebug, debug);
  gl.uniform1i(U.uTint, state.tint ? 1 : 0);
  gl.uniform2f(U.uRes, usCanvas.width, usCanvas.height);
  gl.uniform1f(U.uDepth, state.depth);
  gl.uniform1f(U.uGain, state.gain);
  gl.uniform1f(U.uTime, time);
  gl.uniform1f(U.uTop, topOffset());
  gl.uniform1i(U.uProbe, PROBES[state.probe].id);
  gl.uniform1i(U.uWin, state.win);
  gl.uniform1i(U.uCase, state.cases);
  gl.uniform3f(U.uOrigin, ...o);
  // spaltenweise: lateral, Tiefe, Elevation
  gl.uniformMatrix3fv(U.uRot, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Bildpunkt (cm, wie im Shader) im Fächer des aktuellen Schallkopfs?
function inFan(x, y) {
  if (state.probe === 'linear') return Math.abs(x) < 2 && y >= 0 && y <= state.depth;
  if (state.probe === 'convex') {
    const ry = y + 4, rho = Math.hypot(x, ry);
    return Math.abs(Math.atan2(x, ry)) < 0.62 && rho >= 4 && rho - 4 <= state.depth;
  }
  return y > 0 && Math.hypot(x, y) <= state.depth && Math.abs(Math.atan2(x, y)) < 0.78;
}

// Grobes Raster über die Schnittebene: wo liegt welches Organ? Für die Beschriftung.
const LABELED = TISSUES.map((t, i) => t.tint || i === 1 || i === 10);
function sampleLabels(vol, M, o) {
  const top = topOffset(), sc = usCanvas.height / (state.depth + top);
  const halfW = usCanvas.width / 2 / sc;
  const col = j => [M[0][j], M[1][j], M[2][j]];
  const Lc = col(0), Dc = col(1);
  let off = 0;
  while (off < 30 && classAt(vol, o.map((v, i) => v + Dc[i] * off)) === 0) off++;
  if (off >= 30) off = 0;
  const all = new Map(), fan = new Map();
  const NX = 48, NY = 40;
  for (let iy = 0; iy < NY; iy++) {
    const y = (iy + 0.5) / NY * state.depth;
    for (let ix = 0; ix < NX; ix++) {
      const x = ((ix + 0.5) / NX * 2 - 1) * halfW;
      const p = o.map((v, i) => v + (Lc[i] * x + Dc[i] * y) * 10 + Dc[i] * off);
      const c = classAt(vol, p);
      if (!LABELED[c]) continue;
      for (const m of inFan(x, y) ? [all, fan] : [all]) {
        if (!m.has(c)) m.set(c, []);
        m.get(c).push([x, y]);
      }
    }
  }
  return { all, fan };
}

function drawLabels(ctx, map, W, H) {
  const top = topOffset(), sc = H / (state.depth + top), dpr = window.devicePixelRatio || 1;
  ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const placed = [];
  // große Organe zuerst, Beschriftungen dürfen sich nicht überdecken
  for (const [c, pts] of [...map].sort((a, b) => b[1].length - a[1].length)) {
    if (pts.length < 6) continue;
    // Beschriftung an den Rasterpunkt der Klasse, der ihrem Schwerpunkt am nächsten liegt
    const m = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const p = pts.reduce((a, b) => (Math.hypot(b[0] - m[0], b[1] - m[1]) < Math.hypot(a[0] - m[0], a[1] - m[1]) ? b : a));
    const x = W / 2 + p[0] * sc, y = (p[1] + top) * sc;
    if (placed.some(([a, b]) => Math.abs(a - x) < 80 * dpr && Math.abs(b - y) < 18 * dpr)) continue;
    placed.push([x, y]);
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(TISSUES[c].name, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(TISSUES[c].name, x, y);
  }
  ctx.textAlign = 'start';
}

// Schallfenster auf der Körperskizze im Bedienfeld
const SPOTS = [[58, 128], [142, 120], [100, 112], [100, 218], [74, 72], [126, 72]];

// 3D-Körpermodell aus demselben CT, Sonde und mitbewegte Schallebene
function draw3D(vol, M, o) {
  const name = WINDOWS[state.win].vol;
  if (anat3d.current !== anat3d.models[name]) {
    if (!anat3d.loading) {
      anat3d.loading = anat3d.show(name, `data/${name}/anatomy.glb`).finally(() => { anat3d.loading = null; });
    }
    return;
  }
  anat3d.showFan = state.fan;
  anat3d.update({ o, M, kind: state.probe, depthCm: state.depth, topCm: topOffset(), us: usCanvas, usAspect: usCanvas.width / usCanvas.height });
  const c = $('anat3d');
  anat3d.render(c.clientWidth * (window.devicePixelRatio || 1), c.clientHeight * (window.devicePixelRatio || 1));
}

function drawOverlay(M) {
  const ctx = overlay.getContext('2d');
  const W = overlay.width, H = overlay.height, dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const sc = H / (state.depth + topOffset());
  const y0 = topOffset() * sc;
  ctx.font = `${12 * dpr}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(220,230,240,0.85)';
  ctx.strokeStyle = 'rgba(220,230,240,0.6)';
  ctx.lineWidth = dpr;
  // Tiefenskala rechts vom Bild
  const D = state.depth;
  const half = { linear: [2, 2], convex: [2.33, (4 + D) * 0.58], phased: [0.3, D * 0.7] }[state.probe];
  const xs = Math.min(W - 34 * dpr, W / 2 + half[1] * sc + 10 * dpr);
  for (let cm = 0; cm <= state.depth; cm++) {
    const y = y0 + cm * sc;
    const big = cm % 5 === 0;
    ctx.beginPath(); ctx.moveTo(xs, y); ctx.lineTo(xs + (big ? 10 : 5) * dpr, y); ctx.stroke();
    if (big && cm > 0) ctx.fillText(`${cm}`, xs + 13 * dpr, y + 4 * dpr);
  }
  // Orientierungsmarker links oben
  ctx.fillStyle = '#4fb3ff';
  ctx.beginPath(); ctx.arc(W / 2 - half[0] * sc - 14 * dpr, y0 + 6 * dpr, 5 * dpr, 0, 7); ctx.fill();
  if (state.frozen) {
    ctx.fillStyle = '#4fb3ff';
    ctx.font = `bold ${14 * dpr}px system-ui, sans-serif`;
    ctx.fillText('FREEZE', W - 80 * dpr, 24 * dpr);
  }
  const p = PROBES[state.probe];
  const L = [M[0][0], M[1][0], M[2][0]], Dn = [M[0][1], M[1][1], M[2][1]];
  const deg = r => Math.round(r * 180 / Math.PI);
  $('readout').innerHTML =
    `<span>${state.hidden ? 'Fall verdeckt' : WINDOWS[state.win].name}</span>` +
    `<span>${p.name} ${p.mhz} MHz</span><span>Tiefe ${state.depth} cm</span><span>Gain ${state.gain.toFixed(2)}</span>` +
    `<span>Drehen ${deg(Math.atan2(L[2], L[0]))}° · Fächern ${deg(Math.asin(Math.max(-1, Math.min(1, Dn[2]))))}° · Kippen ${deg(Math.asin(Math.max(-1, Math.min(1, Dn[0]))))}°</span>` +
    `${state.trackInfo ? `<span>${state.trackInfo}</span>` : ''}${state.note ? `<span class="ok">${state.note}</span>` : ''}<span class="${pose.source === 'phone' ? 'ok' : ''}">${pose.source === 'phone' ? 'Handy' : 'Maus'}</span>`;
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.frozen) {
    time += dt;
    if (pose.target) pose.q = pose.q ? qNlerp(pose.q, pose.target, 0.35) : pose.target;
    lastM = currentMatrix();
  }
  requestAnimationFrame(loop);
  if (!window.__sim?.paused) render();
}

// ---------- Zustand und UI ----------
function setProbe(key) {
  state.probe = key;
  state.depth = PROBES[key].def;
  syncUI();
}
function setWindow(i) {
  state.win = i;
  state.slide = [0, 0];
  state.track = null;
  tracker?.reset();
  syncUI();
}
function changeDepth(d) {
  const p = PROBES[state.probe];
  state.depth = Math.max(p.min, Math.min(p.max, state.depth + d));
  syncUI();
}
function calibrate() {
  const q = pose.target || pose.q;
  pose.Rn = q ? matFromQuat(q) : null;
  pose.mouse = { rock: 0, fan: 0, rot: 0 };
  state.slide = [0, 0];
  state.track = null;
  tracker?.anchor();
  lastM = currentMatrix();
}

function setAnat(mode) {
  state.anat = mode;
  $('anatWrap').hidden = mode === 'off';
  $('anat').hidden = mode !== 'cut';
  $('anat3d').hidden = mode !== 'body';
  $('anat3dTools').hidden = mode !== 'body';
  $('anatTitle').textContent = mode === 'cut' ? 'Anatomie im Schnitt' : '3D-Anatomie';
  resize();
  syncUI();
}

function showNote(text) {
  state.note = text;
  clearTimeout(showNote.timer);
  showNote.timer = setTimeout(() => { state.note = ''; }, 4000);
}

// NFC-Tag: probe.html?s=<Szenario> lädt einen verdeckten Fall, ?w=<Fenster> wählt das Schallfenster
function applyTag(m) {
  if (m.s === 'random') { randomCase(); showNote('NFC: Zufallsfall geladen'); }
  const sc = SCENARIOS.find(x => x.id === m.s);
  if (sc) { state.cases = sc.cases; state.hidden = true; showNote('NFC: Fall geladen'); }
  const wi = WINDOWS.findIndex(x => x.key === m.w);
  if (wi >= 0) { setWindow(wi); showNote(`NFC: ${WINDOWS[wi].name}`); }
  syncUI();
}

function randomCase() {
  let c = 0;
  for (const f of FINDINGS) if (Math.random() < 0.3) c |= f.bit;
  if ((c & 48) === 48) c &= ~32;
  state.cases = c;
  state.hidden = true;
}

function syncUI() {
  for (const b of document.querySelectorAll('#probeButtons button')) b.classList.toggle('active', b.dataset.key === state.probe);
  for (const b of document.querySelectorAll('#winButtons button')) b.classList.toggle('active', +b.dataset.i === state.win);
  for (const c of document.querySelectorAll('#spots circle')) c.classList.toggle('active', +c.dataset.i === state.win);
  const p = PROBES[state.probe];
  Object.assign($('depth'), { min: p.min, max: p.max, value: state.depth });
  $('depthVal').textContent = `${state.depth} cm`;
  $('gain').value = state.gain;
  $('gainVal').textContent = state.gain.toFixed(2);
  $('freezeBtn').classList.toggle('active', state.frozen);
  for (const b of document.querySelectorAll('#anatButtons button')) b.classList.toggle('active', b.dataset.mode === state.anat);
  $('tint').checked = state.tint;
  const hint = WINDOWS[state.win].hint;
  $('winHint').textContent = hint === state.probe ? '' : `Üblich für dieses Fenster: ${PROBES[hint].name}`;
  $('findings').hidden = state.hidden;
  $('revealBtn').hidden = !state.hidden;
  for (const c of document.querySelectorAll('#findings input')) c.checked = (state.cases & +c.dataset.bit) !== 0;
  sendState();
}

function sendState() {
  if (conn && conn.open) {
    conn.send({ t: 'state', probe: state.probe, win: state.win, depth: state.depth, gain: state.gain, frozen: state.frozen });
  }
}

function button(label, onClick, data = {}) {
  const b = document.createElement('button');
  b.textContent = label;
  Object.assign(b.dataset, data);
  b.addEventListener('click', onClick);
  return b;
}

function buildUI() {
  for (const [key, p] of Object.entries(PROBES)) $('probeButtons').append(button(p.name, () => setProbe(key), { key }));
  WINDOWS.forEach((w, i) => $('winButtons').append(button(`${i + 1} ${w.name}`, () => setWindow(i), { i })));
  SPOTS.forEach(([x, y], i) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    Object.assign(c.dataset, { i });
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 9);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = WINDOWS[i].name;
    c.append(t);
    c.addEventListener('click', () => setWindow(i));
    $('spots').append(c);
  });
  SCENARIOS.forEach(s => $('scenarioButtons').append(button(s.name, () => { state.cases = s.cases; state.hidden = false; syncUI(); })));
  for (const f of FINDINGS) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.dataset.bit = f.bit;
    c.addEventListener('change', () => { state.cases ^= f.bit; syncUI(); });
    l.append(c, ' ' + f.name);
    $('findings').append(l);
  }
  $('randomBtn').addEventListener('click', () => { randomCase(); syncUI(); });
  for (const b of document.querySelectorAll('#anatButtons button')) b.addEventListener('click', () => setAnat(b.dataset.mode));
  $('tint').addEventListener('change', e => { state.tint = e.target.checked; });
  $('fanToggle').addEventListener('change', e => { state.fan = e.target.checked; });
  $('viewReset').addEventListener('click', () => anat3d.resetView());
  $('camBtn').addEventListener('click', toggleWebcam);
  buildTagList();
  $('revealBtn').addEventListener('click', () => { state.hidden = false; syncUI(); });
  $('depth').addEventListener('input', e => { state.depth = +e.target.value; syncUI(); });
  $('gain').addEventListener('input', e => { state.gain = +e.target.value; syncUI(); });
  $('bodyScale').addEventListener('input', e => { state.bodyScale = +e.target.value; $('bodyScaleVal').textContent = `${state.bodyScale} %`; });
  $('freezeBtn').addEventListener('click', () => { state.frozen = !state.frozen; syncUI(); });
  $('calibBtn').addEventListener('click', calibrate);
}

// ---------- Maus und Tastatur als Ersatz für das Handy ----------
function bindMouse() {
  let drag = null;
  overlay.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; overlay.setPointerCapture(e.pointerId); });
  overlay.addEventListener('pointerup', () => { drag = null; });
  overlay.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * 0.006, dy = (e.clientY - drag.y) * 0.006;
    drag = { x: e.clientX, y: e.clientY };
    pose.source = 'mouse';
    if (e.shiftKey) pose.mouse.rot += dx;
    else { pose.mouse.rock += dx; pose.mouse.fan += dy; }
  });
  overlay.addEventListener('wheel', e => { e.preventDefault(); changeDepth(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '6') setWindow(+k - 1);
    else if (k === 'l') setProbe('linear');
    else if (k === 'k' || k === 'c') setProbe('convex');
    else if (k === 's') setProbe('phased');
    else if (k === 'f') { state.frozen = !state.frozen; syncUI(); }
    else if (k === 'n') calibrate();
    else if (k === 'a') setAnat({ off: 'cut', cut: 'body', body: 'off' }[state.anat]);
    else if (k === 't') { state.tint = !state.tint; syncUI(); }
    else if (e.key.startsWith('Arrow')) {
      const d = { ArrowLeft: [-0.3, 0], ArrowRight: [0.3, 0], ArrowUp: [0, 0.3], ArrowDown: [0, -0.3] }[e.key];
      slide(d[0], d[1]);
      e.preventDefault();
    }
  });
}

function slide(dx, dz) {
  state.slide = [Math.max(-8, Math.min(8, state.slide[0] + dx)), Math.max(-8, Math.min(8, state.slide[1] + dz))];
}

// ---------- Kopplung mit dem Handy (WebRTC über PeerJS) ----------
function onData(m) {
  switch (m.t) {
    case 'pose': pose.target = m.q; pose.source = 'phone'; break;
    case 'probe': if (m.v in PROBES) setProbe(m.v); break;
    case 'calib': calibrate(); showNote('Kalibriert'); break;
    case 'tag': applyTag(m); break;
    case 'hello': sendState(); break;
  }
}

function startPeer() {
  if (!window.Peer) { $('connStatus').textContent = 'Kopplung nicht verfügbar, nur Maussteuerung'; return; }
  const code = Math.random().toString(36).slice(2, 8);
  const peer = new Peer(`pocus-sim-${code}`);
  peer.on('open', () => {
    const url = new URL('probe.html', location.href);
    url.hash = code;
    $('pairCode').textContent = code;
    $('connStatus').textContent = 'Warte auf Handy …';
    const qr = qrcode(0, 'M');
    qr.addData(url.href);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $('qr').title = url.href;
  });
  peer.on('connection', c => {
    if (conn) conn.close();
    conn = c;
    c.on('open', () => { $('connStatus').textContent = 'Handy verbunden'; $('connStatus').classList.add('ok'); sendState(); });
    c.on('data', onData);
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      pose.source = 'mouse';
      pose.target = pose.q = pose.Rn = null;
      $('connStatus').textContent = 'Handy getrennt, warte …';
      $('connStatus').classList.remove('ok');
    });
  });
  peer.on('error', err => {
    if (err.type === 'unavailable-id') { peer.destroy(); startPeer(); return; }
    $('connStatus').textContent = `Verbindungsfehler: ${err.type}`;
  });
  peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 3000));
}

// ---------- Webcam-Tracking (Marker hinten am Handy) ----------
async function toggleWebcam() {
  if (tracker) {
    tracker.stop();
    tracker = null;
    state.track = null;
    state.trackInfo = '';
    $('camBtn').classList.remove('active');
    $('camBtn').textContent = 'Webcam starten';
    $('camBox').hidden = true;
    return;
  }
  try {
    tracker = new WebcamTracker($('camVideo'), $('camPreview'), () => (pose.q ? matFromQuat(pose.q) : null), onTrack);
    await tracker.start();
    $('camBtn').classList.add('active');
    $('camBtn').textContent = 'Webcam stoppen';
    $('camBox').hidden = false;
  } catch (err) {
    tracker = null;
    $('camStatus').textContent = `Webcam nicht verfügbar: ${err.message}`;
    $('camBox').hidden = false;
  }
}

function onTrack(u) {
  if (u.ok) state.track = u.d;
  state.trackInfo = u.ok ? 'Webcam: verfolgt' : (!u.seen ? 'Webcam: Marker nicht im Bild' : (u.noGyro ? 'Webcam: Handy fehlt' : 'Webcam: kalibrieren'));
  $('camStatus').textContent = u.ok ? `Verschiebung ${u.d.map(v => Math.round(v / 10)).join(' / ')} cm · Abstand ${u.dist} cm`
    : !u.seen ? 'Marker nicht im Bild'
    : u.noGyro ? 'Marker erkannt, Handy koppeln und Sensoren starten'
    : 'Marker erkannt, Sonde ansetzen und am Handy „Kalibrieren“ tippen';
}

function buildTagList() {
  const base = new URL('probe.html', location.href).href;
  const rows = [
    ...SCENARIOS.map(s => [`Fall: ${s.name}`, `${base}?s=${s.id}`]),
    ['Fall: Zufall', `${base}?s=random`],
    ...WINDOWS.map(w => [`Fenster: ${w.name}`, `${base}?w=${w.key}`]),
  ];
  for (const [label, url] of rows) {
    const li = document.createElement('li');
    const b = button('Kopieren', () => navigator.clipboard?.writeText(url).then(() => { b.textContent = 'Kopiert'; }));
    const code = document.createElement('code');
    code.textContent = url;
    li.append(label, ' ', b, document.createElement('br'), code);
    $('tagList').append(li);
  }
}

buildUI();
bindMouse();
resize();
syncUI();
startPeer();
requestAnimationFrame(loop);
window.__sim = { state, pose, setWindow, setProbe, calibrate, setAnat, applyTag };
