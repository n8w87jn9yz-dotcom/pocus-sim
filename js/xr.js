// Quest-3-Version: Mixed Reality an der Laerdal Resus Anne (Phase 0, siehe docs/xr.md).
// Ein Touch-Controller steckt im gedruckten Sondengehäuse und liefert die volle Lage der Sonde.
// Ablauf: Sonde einmessen (Pivot + Tisch), Puppe über die sechs eFAST-Punkte auf den CT-Körper abbilden, schallen.
// Weltkoordinaten: Meter (WebXR local-floor). CT: mm, RAS, gemeinsamer Körperraum = Abdomen-Volumen
// (Thorax liegt um meta.offset verschoben, tools/align_volumes.py).
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { PROBES, WINDOWS, SCENARIOS, matFromQuat, matMul, matT, rotX, rotY, rotZ } from './common.js';
import {
  add, sub, len, norm, cross, mulV, cols, col, inv3, det3,
  pivotCalibrate, fitAffine, applyAffine, polarRotation, rotAngle,
} from './xrmath.js';
import { UltrasoundRenderer } from './usrender.js';

const params = new URLSearchParams(location.search);
const PROBE_HAND = params.get('hand') === 'left' ? 'left' : 'right';
const OTHER_HAND = PROBE_HAND === 'left' ? 'right' : 'left';
const US_H = +params.get('h') || 300;
const US_EVERY = Math.max(1, +params.get('jeder') || 2);   // Ultraschallbild in jedem n-ten Brillenbild
const CONTACT_MM = 8;      // so weit darf die Spitze über der CT-Haut schweben und gilt noch als aufgesetzt
const SWITCH_MM = 15;      // Fensterwechsel erst, wenn ein anderes Fenster so viel näher liegt
const STORE = 'pocus-xr-sonde';

const $ = id => document.getElementById(id);
const state = {
  mode: 'load', probe: 'convex', depth: PROBES.convex.def, gain: 1, frozen: false,
  scenario: 0, anatomy: false, win: 0, contact: false, time: 0, note: '', sim: false,
};
// Sonde im Controllersystem: t Spitze (m), Roff Spalten lateral/Tiefe/Elevation
let calib = null;
try { const c = JSON.parse(localStorage.getItem(STORE) || 'null'); if (c?.t && c?.Roff) calib = c; } catch { /* neu einmessen */ }
let reg = null;            // { A, b, res, R, scale }: Welt (m) -> CT (mm)
let points = [];           // erfasste eFAST-Punkte: { tip, Rw }
let pivotSamples = [];
let landmarks = [];        // je Fenster: Hautpunkt im gemeinsamen CT-Raum und Standardlage
const volumes = {};

// ---------- Ultraschallbild ----------
const usCanvas = $('us');
usCanvas.height = US_H;
usCanvas.width = Math.round(US_H * 4 / 3);
const us = new UltrasoundRenderer(usCanvas);

async function loadAll() {
  for (const name of ['abdomen', 'thorax']) {
    $('status').textContent = `Lade CT ${name} …`;
    volumes[name] = await us.loadVolume(name);
  }
  landmarks = WINDOWS.map(w => {
    const vol = volumes[w.vol], m = vol.meta.windows[w.key];
    const s = us.skin(vol, m.origin, m.D);
    return { p: add(s ? s.p : m.origin, vol.offset), B: cols(m.L, m.D, m.E) };
  });
}

// ---------- Szene ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 2, 0.01, 20);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.5));
const light = new THREE.DirectionalLight(0xffffff, 1.5);
light.position.set(0.5, 2, 1);
scene.add(light);

// Textur aus einer Canvas eines anderen Kontexts: ohne Mipmaps, damit das Hochladen auf der Quest billig bleibt
const canvasTex = c => Object.assign(new THREE.CanvasTexture(c), { colorSpace: THREE.SRGBColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter });
const usTex = canvasTex(usCanvas);
const hudCanvas = $('hud');
const hudTex = canvasTex(hudCanvas);
// virtuelles Gerät: Bild 32 x 24 cm, darunter die Anzeige
const monitor = new THREE.Group();
const screenW = 0.32;
monitor.add(new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenW * 3 / 4), new THREE.MeshBasicMaterial({ map: usTex })));
const hud = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenW * 400 / 1024), new THREE.MeshBasicMaterial({ map: hudTex, transparent: true }));
hud.position.y = -screenW * 3 / 8 - screenW * 200 / 1024 - 0.01;
monitor.add(hud);
const frame = new THREE.Mesh(new THREE.BoxGeometry(screenW + 0.02, screenW * 3 / 4 + 0.02, 0.01), new THREE.MeshStandardMaterial({ color: 0x222831 }));
frame.position.z = -0.006;
monitor.add(frame);
monitor.visible = false;
scene.add(monitor);

const tipDot = new THREE.Mesh(new THREE.SphereGeometry(0.004), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
scene.add(tipDot);
const markGroup = new THREE.Group();
scene.add(markGroup);
const anatGroup = new THREE.Group();
anatGroup.matrixAutoUpdate = false;
anatGroup.visible = false;
scene.add(anatGroup);

function setMarks(list, color) {
  markGroup.clear();
  for (const p of list) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.006), new THREE.MeshBasicMaterial({ color }));
    m.position.set(...p);
    markGroup.add(m);
  }
}

// Organe aus anatomy.glb in die Puppe legen (Röntgenblick); Haut und Bauchwand weglassen
const ORGAN = {
  liver: 0x9c3324, spleen: 0x7a2a52, kidney: 0xb0502e, heart: 0xc0392b, lung: 0xe8a0a0, bowel: 0xd09070,
  fluid: 0xe0d060, ribs: 0xeee6d0, sternum: 0xeee6d0, spine: 0xeee6d0, pelvis: 0xeee6d0, cartilage: 0xb8d0d0,
  artery: 0xd01818, vein: 0x2850b0,
};
const KEEP = { abdomen: ['liver', 'spleen', 'kidney', 'bowel', 'pelvis', 'spine', 'artery', 'vein'], thorax: ['lung', 'heart', 'ribs', 'sternum', 'cartilage'] };
let anatLoaded = false;
async function loadAnatomy() {
  if (anatLoaded) return;
  anatLoaded = true;
  try { await loadAnatomyFiles(); } catch (err) { anatLoaded = false; state.note = `Anatomie nicht geladen: ${err.message}`; }
}
async function loadAnatomyFiles() {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  for (const name of ['abdomen', 'thorax']) {
    const g = await loader.loadAsync(`data/${name}/anatomy.glb`);
    const root = new THREE.Group();
    root.position.set(...volumes[name].offset);
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      const key = Object.keys(ORGAN).find(k => o.name.startsWith(k) || o.parent?.name?.startsWith(k));
      o.visible = !!key && KEEP[name].includes(key);
      if (o.visible && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();   // GLB ohne Normalen
      o.material = new THREE.MeshStandardMaterial({ color: ORGAN[key] || 0x888888, transparent: true, opacity: 0.55, depthWrite: false });
    });
    root.add(g.scene);
    anatGroup.add(root);
  }
}
function placeAnatomy() {
  if (!reg) return;
  // Welt = A^-1 (CT - b)
  const Ai = inv3(reg.A), t = mulV(Ai, reg.b).map(v => -v);
  anatGroup.matrix.set(Ai[0][0], Ai[0][1], Ai[0][2], t[0], Ai[1][0], Ai[1][1], Ai[1][2], t[1], Ai[2][0], Ai[2][1], Ai[2][2], t[2], 0, 0, 0, 1);
}

// ---------- Eingaben ----------
// je Hand: { R (Drehung zeilenweise), p (m), buttons[], axes[] }; Kantenerkennung über prev
const prev = { left: [], right: [] };
function readXR(xrFrame) {
  const out = {}, ref = renderer.xr.getReferenceSpace();
  for (const src of xrFrame.session.inputSources) {
    if (!src.gripSpace || !src.gamepad) continue;
    const pose = xrFrame.getPose(src.gripSpace, ref);
    if (!pose) continue;
    const { position: p, orientation: q } = pose.transform;
    out[src.handedness] = {
      R: matFromQuat([q.x, q.y, q.z, q.w]), p: [p.x, p.y, p.z],
      buttons: src.gamepad.buttons.map(b => b.pressed), axes: [...src.gamepad.axes],
      emulated: pose.emulatedPosition,
    };
  }
  return out;
}
const pressed = (h, hand, i) => !!h?.buttons[i] && !prev[hand][i];
const holdT = { left: 0, right: 0 };
function held(h, hand, i, dt) {
  if (!h?.buttons[i]) { holdT[hand] = 0; return false; }
  const before = holdT[hand];
  holdT[hand] += dt;
  return before < 1 && holdT[hand] >= 1;
}

// Blickrichtung waagerecht; null, wenn fast senkrecht nach unten geschaut wird
function headForward() {
  const d = new THREE.Vector3();
  renderer.xr.getCamera().getWorldDirection(d);
  return Math.hypot(d.x, d.z) < 0.3 ? null : norm([d.x, 0, d.z]);
}

// ---------- Ablauf ----------
function setMode(m, note = '') {
  state.mode = m;
  state.note = note;
  if (m === 'points') { points = []; reg = null; setMarks([], 0xffaa00); }
  if (m === 'pivot') pivotSamples = [];
}

function tipOf(h) { return add(mulV(h.R, calib.t), h.p); }

function finishPivot() {
  const r = pivotSamples.length > 60 ? pivotCalibrate(pivotSamples) : null;
  if (!r) return setMode('pivot', 'Zu wenig Daten: Trigger länger halten und dabei kreisen.');
  if (r.spread < 0.6) return setMode('pivot', `Zu wenig gekreist (${deg(r.spread)}°), bitte weiter neigen.`);
  if (r.rms > 0.004) return setMode('pivot', `Spitze unruhig (${(r.rms * 1000).toFixed(1)} mm), Sonde fester auf den Kegel setzen.`);
  calib = { t: r.t, Roff: null, rms: r.rms };
  setMode('table', `Spitze eingemessen: ${(len(r.t) * 100).toFixed(1)} cm vom Controller, Restfehler ${(r.rms * 1000).toFixed(1)} mm.`);
}

function captureTable(h) {
  // Schallfläche nach unten, Marker zeigt von dir weg: Marker liegt auf -L (wie in WINDOWS/meta.json)
  const f = headForward();
  if (!f) return setMode('table', 'Beim Trigger bitte geradeaus schauen, nicht senkrecht nach unten.');
  const D = [0, -1, 0], L = f.map(v => -v), E = cross(L, D);
  calib.Roff = matMul(matT(h.R), cols(L, D, E));
  try { localStorage.setItem(STORE, JSON.stringify(calib)); } catch { /* gilt nur bis zum Neuladen */ }
  setMode('points', 'Sonde eingemessen und gespeichert.');
}

function capturePoint(tip, Rw) {
  points.push({ tip, Rw });
  setMarks(points.map(p => p.tip), 0xffaa00);
  if (points.length === WINDOWS.length) solveRegistration();
}

function solveRegistration() {
  const T = fitAffine(points.map(p => p.tip), landmarks.map(l => l.p));
  if (!T || det3(T.A) <= 0) return setMode('points', 'Registrierung gescheitert: Punkte vertauscht? Bitte neu aufnehmen.');
  const R = polarRotation(T.A);
  reg = { ...T, R, scale: Math.cbrt(det3(T.A)) / 1000 };
  // Abweichung der gehaltenen Sondenlage von der Standardlage je Fenster (Rückmeldung zur Sondenführung)
  reg.tilt = points.map((p, i) => rotAngle(matMul(R, p.Rw), landmarks[i].B));
  placeAnatomy();
  const Ai = inv3(T.A);
  setMarks(landmarks.map(l => mulV(Ai, sub(l.p, T.b))), 0x40d080);
  setMode('scan', `Registriert: Restfehler max. ${Math.max(...T.res).toFixed(0)} mm, Maßstab CT/Puppe ${reg.scale.toFixed(2)}.`);
  showResult();
}

function nearestWindow(p) {
  const d = landmarks.map(l => len(sub(l.p, p)));
  const best = d.indexOf(Math.min(...d));
  if (best !== state.win && d[best] + SWITCH_MM < d[state.win]) state.win = best;
  return state.win;
}

// Sondenlage (Welt) -> Bild. Gibt zurück, ob die Sonde aufliegt.
let frameNo = 0;
function scan(tip, Rw) {
  const ct = applyAffine(reg, tip), M = matMul(reg.R, Rw);
  const w = WINDOWS[nearestWindow(ct)], vol = volumes[w.vol];
  const local = sub(ct, vol.offset), D = col(M, 1);
  // von 40 mm vor der Spitze bis CONTACT_MM dahinter nach der CT-Haut suchen
  const s = us.skin(vol, local, D, 40, 40 + CONTACT_MM);
  state.contact = !!s;
  if (state.frozen || frameNo % US_EVERY) return;
  if (!s) us.clear();
  else us.draw(vol, M, s.p, { ...state, cases: SCENARIOS[state.scenario].cases });
  usTex.needsUpdate = true;
}

function handleInput(H, dt) {
  const P = H[PROBE_HAND], O = H[OTHER_HAND];
  // Stick 1 s gedrückt halten: rechts Sonde neu einmessen, links Puppe neu registrieren (kurzes Mitklicken zählt nicht)
  if (held(P, PROBE_HAND, 3, dt)) setMode('pivot', 'Sonde neu einmessen.');
  if (held(O, OTHER_HAND, 3, dt) && calib?.Roff) setMode('points', 'Puppe neu registrieren.');
  if (O && pressed(O, OTHER_HAND, 4)) state.scenario = (state.scenario + 1) % SCENARIOS.length;
  if (O && pressed(O, OTHER_HAND, 5)) { state.anatomy = !state.anatomy; if (state.anatomy) loadAnatomy(); }
  // linker Griff: Gerät mitnehmen
  if (O?.buttons[1]) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...O.p), quatOf(O.R), new THREE.Vector3(1, 1, 1));
    if (!grab) grab = m.clone().invert().multiply(monitor.matrixWorld);
    monitor.matrix.copy(m.multiply(grab));
    monitor.matrix.decompose(monitor.position, monitor.quaternion, monitor.scale);
  } else grab = null;
  if (!P) return;
  // Controller außer Sicht der Kameras: Lage nur geschätzt, nichts aufnehmen
  if (P.emulated) { state.note = 'Sonde nicht im Blick der Brille.'; return; }
  if (state.note === 'Sonde nicht im Blick der Brille.') state.note = '';
  if (state.mode === 'pivot') {
    if (P.buttons[0]) pivotSamples.push({ R: P.R, p: P.p });
    else if (prev[PROBE_HAND][0]) finishPivot();
    return;
  }
  if (state.mode === 'table' && pressed(P, PROBE_HAND, 0)) return captureTable(P);
  if (!calib?.Roff) return;
  const tip = tipOf(P), Rw = matMul(P.R, calib.Roff);
  tipDot.position.set(...tip);
  if (state.mode === 'points') {
    if (pressed(P, PROBE_HAND, 0)) capturePoint(tip, Rw);
    if (pressed(P, PROBE_HAND, 5) && points.length) { points.pop(); setMarks(points.map(p => p.tip), 0xffaa00); }
    return;
  }
  if (state.mode !== 'scan') return;
  if (pressed(P, PROBE_HAND, 4)) state.frozen = !state.frozen;
  if (pressed(P, PROBE_HAND, 5)) {
    const keys = Object.keys(PROBES);
    state.probe = keys[(keys.indexOf(state.probe) + 1) % keys.length];
    state.depth = PROBES[state.probe].def;
  }
  const [, , ax = 0, ay = 0] = P.axes, p = PROBES[state.probe];
  if (Math.abs(ay) > 0.3) state.depth = Math.max(p.min, Math.min(p.max, state.depth - ay * 6 * dt));
  if (Math.abs(ax) > 0.3) state.gain = Math.max(0.3, Math.min(2.5, state.gain + ax * 0.8 * dt));
  scan(tip, Rw);
  tipDot.material.color.set(state.contact ? 0x40d080 : 0xffaa00);
}
let grab = null;
const quatOf = R => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1));

// ---------- Anzeige ----------
const deg = r => Math.round(r * 180 / Math.PI);
const STEP = {
  pivot: ['1/3 Sonde einmessen', 'Sondenloch auf den Kegel des Kalibrierbocks setzen,', 'Trigger halten und die Sonde 10 s kreisen.'],
  table: ['2/3 Sondenachsen', 'Schallfläche flach auf den Tisch, Marker zeigt von dir weg,', 'dann Trigger drücken.'],
};
function hudLines() {
  if (state.mode === 'load') return ['Lade CT …'];
  if (STEP[state.mode]) return STEP[state.mode];
  if (state.mode === 'points') {
    const w = WINDOWS[points.length];
    return [`3/3 Puppe registrieren: Punkt ${points.length + 1} von ${WINDOWS.length}`, w.name, ...w.hold, 'Sonde so aufsetzen, Trigger. B = letzten Punkt zurück.'];
  }
  const p = PROBES[state.probe], sc = SCENARIOS[state.scenario];
  return [
    `${WINDOWS[state.win].name} · ${state.contact ? 'aufgesetzt' : 'keine Hautberührung'}${state.frozen ? ' · FREEZE' : ''}`,
    `${p.name} ${p.mhz} MHz · Tiefe ${state.depth.toFixed(0)} cm · Gain ${state.gain.toFixed(2)}`,
    `Fall: ${sc.name}`,
    `Bild ${usCanvas.width}x${usCanvas.height}, jedes ${US_EVERY}. Brillenbild · GPU ${us.gpuMs == null ? '–' : us.gpuMs.toFixed(1) + ' ms'} · ${fps.toFixed(0)} fps`,
  ];
}
let hudText = '';
function drawHud() {
  const lines = [...hudLines(), state.note].filter(Boolean), text = lines.join('\n');
  if (text === hudText) return;
  hudText = text;
  const c = hudCanvas.getContext('2d');
  c.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  c.fillStyle = 'rgba(11,16,22,0.85)';
  c.fillRect(0, 0, hudCanvas.width, hudCanvas.height);
  c.fillStyle = '#dbe4ee';
  lines.forEach((l, i) => {
    c.font = `${i === 0 ? 'bold ' : ''}34px system-ui, sans-serif`;
    c.fillText(l, 24, 54 + i * 52, hudCanvas.width - 48);
  });
  hudTex.needsUpdate = true;
}

function showResult() {
  if (!reg) return;
  $('result').innerHTML = `<h2>Registrierung</h2><table><tr><th>Fenster</th><th>Restfehler</th><th>Abweichung Standardlage</th></tr>${WINDOWS.map((w, i) => `<tr><td>${w.name}</td><td>${reg.res[i].toFixed(1)} mm</td><td>${deg(reg.tilt[i])}°</td></tr>`).join('')}</table>`;
}

// ---------- Schleife ----------
let last = performance.now(), fps = 0, placed = false;
renderer.setAnimationLoop((now, xrFrame) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps = fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
  if (!state.frozen) state.time += dt;
  frameNo++;
  const H = xrFrame ? readXR(xrFrame) : sim ? sim(dt) : {};
  if (xrFrame && !placed) placeMonitor();
  if (state.mode !== 'load') handleInput(H, dt);
  // nur aktualisieren, wenn die Hand da ist: sonst gilt eine gehaltene Taste nach einem Aussetzer als neu gedrückt
  for (const hand of ['left', 'right']) if (H[hand]) prev[hand] = H[hand].buttons;
  anatGroup.visible = state.anatomy && anatGroup.children.length > 0;
  if (frameNo % 6 === 0) drawHud();
  renderer.render(scene, camera);
});

function placeMonitor() {
  const cam = renderer.xr.getCamera(), f = headForward();
  const p = cam.getWorldPosition(new THREE.Vector3());
  monitor.position.set(p.x + f[0] * 0.6 + f[2] * 0.25, p.y - 0.25, p.z + f[2] * 0.6 - f[0] * 0.25);
  monitor.lookAt(p.x, monitor.position.y, p.z);
  monitor.visible = true;
  placed = true;
}

$('enter').addEventListener('click', async () => {
  let session;
  try { session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'] }); }
  catch (err) { $('status').textContent = `Mixed Reality nicht gestartet: ${err.message}`; return; }
  placed = false;
  session.addEventListener('end', () => { monitor.visible = false; });
  await renderer.xr.setSession(session);
  // Neu zentriert (Meta-Taste lang) oder Raum neu erkannt: Weltursprung verschoben, Registrierung stimmt nicht mehr
  renderer.xr.getReferenceSpace()?.addEventListener('reset', () => {
    if (calib?.Roff) setMode('points', 'Raum neu ausgerichtet: bitte Puppe neu registrieren.');
    placed = false;
  });
});

// ---------- Simulation am Rechner ----------
// Bekannte "Puppe": CT-Körper um 8 % verkleinert, rückenlings auf einem Tisch, Kopf von dir weg.
// Die Sonde fährt nacheinander die Fenster ab; die Erfassung der Punkte bekommt 3 mm und 4° Zufallsfehler.
let sim = null;
function startSim() {
  state.sim = true;
  const k = 0.00092, Q = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
  const c0 = [200, 150, 330], t0 = sub([0, 0.85, -0.6], mulV(Q, c0.map(v => v * k)));
  const toWorld = c => add(mulV(Q, c.map(v => v * k)), t0);
  calib = { t: [0.01, -0.03, 0.13], Roff: matMul(rotX(1.1), rotZ(0.2)) };
  const grip = (tip, Rw) => { const R = matMul(Rw, matT(calib.Roff)); return { R, p: sub(tip, mulV(R, calib.t)), buttons: [], axes: [] }; };
  const rnd = () => (Math.random() - 0.5) * 2;
  setMode('points');
  for (const l of landmarks) {
    const noise = matMul(rotX(rnd() * 0.07), rotY(rnd() * 0.07));
    const g = grip(toWorld(add(l.p, [rnd() * 3, rnd() * 3, rnd() * 3])), matMul(Q, matMul(l.B, noise)));
    capturePoint(tipOf(g), matMul(g.R, calib.Roff));
  }
  camera.position.set(0.55, 1.35, 0.25);
  camera.lookAt(0, 0.85, -0.6);
  monitor.position.set(0.45, 1.05, -0.45);
  monitor.lookAt(camera.position);
  monitor.visible = true;
  state.anatomy = true;
  loadAnatomy();
  let t = 0;
  sim = dt => {
    t += dt;
    const i = Math.floor(t / 4) % landmarks.length, u = t % 4, l = landmarks[i];
    state.probe = WINDOWS[i].hint;
    state.depth = WINDOWS[i].tiefe || PROBES[state.probe].def;
    // fächern und leicht gleiten wie beim Suchen
    const B = matMul(l.B, rotX(0.25 * Math.sin(u * 1.6)));
    const tip = add(l.p, col(l.B, 0), 12 * Math.sin(u * 0.8));
    return { [PROBE_HAND]: grip(toWorld(tip), matMul(Q, B)) };
  };
}
function resizeScene() {
  const c = $('scene');
  renderer.setSize(c.clientWidth, c.clientHeight, false);
  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeScene);
resizeScene();

loadAll().then(async () => {
  setMode(calib?.Roff ? 'points' : 'pivot');
  $('sim').addEventListener('click', startSim);
  const ok = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
  $('enter').disabled = !ok;
  $('status').textContent = ok ? 'Bereit. In der Quest auf „Mixed Reality starten“ tippen.'
    : 'CT geladen. Dieser Browser kann keine Mixed Reality, nur die Simulation läuft hier.';
  if (params.has('sim')) startSim();
  window.__xr = { state, landmarks, get reg() { return reg; }, volumes };
}).catch(err => { $('status').textContent = `Fehler: ${err.message}`; console.error(err); });
