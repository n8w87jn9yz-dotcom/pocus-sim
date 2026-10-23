// Halte-Bilder im Atlas-Look: ganzer Mensch als glasig-blaue Hülle (MakeHuman-Grundmodell, CC0, tools/human),
// auf den CT-Rumpf eingepasst; Zielorgan in natürlicher Farbe, Gefäße fein rot, Sonde orange an der Standardlage
// aus meta.json, Schallebene angedeutet.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { WINDOWS } from '../js/common.js';
import { probeMesh, fanShape } from '../js/anatomy3d.js';

// Zielorgane je Fenster; clip begrenzt auf einen Teil des Modells (Harnblase hängt mit der Gallenblase zusammen,
// die Lunge ist ein Modell für beide Seiten). Grenzen relativ zur Sondenposition in mm.
const TARGET = {
  ruq: { keys: ['liver', 'kidney'], clip: { x: [-160, 100] } },
  luq: { keys: ['spleen', 'kidney'], clip: { x: [-100, 160] } },
  subxiphoid: { keys: ['heart'] },
  pelvis: { keys: ['fluid'], clip: { z: [-200, 70] } },
  lung_r: { keys: ['lung'], clip: { x: [-20, 400], z: [-170, 300] } },
  lung_l: { keys: ['lung'], clip: { x: [-400, 20], z: [-170, 300] } },
};

// Fresnel-Glühen: Ränder hell, Flächen fast durchsichtig, additiv wie ein Röntgenbild.
// Fragmente außerhalb von min…max (Weltkoordinaten) fallen weg; fade blendet um einen Punkt herum aus
// (voll bis r0, weg ab r1), damit angedeutete Arme und Beine weich auslaufen.
function holo(color, base, rim, power = 2.5, { min = [-1e5, -1e5, -1e5], max = [1e5, 1e5, 1e5], fade = null } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uBase: { value: base }, uRim: { value: rim }, uPow: { value: power },
      uMin: { value: new THREE.Vector3(...min) }, uMax: { value: new THREE.Vector3(...max) },
      uFadeC: { value: new THREE.Vector3(...(fade?.c || [0, 0, 0])) }, uFadeR: { value: new THREE.Vector2(...(fade?.r || [1e6, 2e6])) },
    },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vW = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor, uMin, uMax, uFadeC; uniform vec2 uFadeR; uniform float uBase, uRim, uPow;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        if (any(lessThan(vW, uMin)) || any(greaterThan(vW, uMax))) discard;
        float f = 1.0 - smoothstep(uFadeR.x, uFadeR.y, distance(vW, uFadeC));
        float r = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        gl_FragColor = vec4(uColor * (uBase + uRim * pow(r, uPow)) * f, 1.0); }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// Körperhülle: erst nur Tiefe schreiben, dann nur die vorderste Fläche als Fresnel-Glühen zeichnen.
// So verschmelzen überlappende Teile (Rumpf, Hals, Kopf) zu einer glatten Silhouette ohne innere Linien.
const SKIN = 0x3a8cff;
function shell(geo, opts = {}) {
  const depth = holo(SKIN, 0, 0, 1, opts);
  Object.assign(depth, { colorWrite: false, depthWrite: true, transparent: false, blending: THREE.NormalBlending });
  const glow = holo(SKIN, 0.11, 1.15, 2.0, opts);
  glow.depthFunc = THREE.LessEqualDepth;
  const g = new THREE.Group();
  const d = new THREE.Mesh(geo, depth), c = new THREE.Mesh(geo, glow);
  d.renderOrder = 0; c.renderOrder = 1;
  g.add(d, c);
  return g;
}

// Menschmodell laden (tools/human/body.bin, siehe convert_makehuman.py): Einheit dm, x rechts, y vorn, z oben
async function loadHuman() {
  const buf = await (await fetch('human/body.bin')).arrayBuffer();
  const [nV, nI] = new Uint32Array(buf, 0, 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 8, nV * 3).slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 8 + nV * 12, nI).slice(), 1));
  return geo;
}

// Modell auf den CT-Rumpf einpassen: Drosselgrube und Hüftgelenk nach Körperproportionen (82 % und 53 % der
// Körperhöhe), Breite und Tiefe an der Taille an das CT angleichen
function fitHuman(src, c, W, T, zHip, zJug) {
  const geo = src.clone();
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox, H = max.z - min.z;
  const zj = min.z + 0.818 * H, zh = min.z + 0.53 * H, zw = min.z + 0.62 * H;
  const p = geo.attributes.position;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getZ(i) - zw) > 0.15 || Math.abs(p.getX(i)) > 2.2) continue;   // Taille ohne Arme
    x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i)); y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i));
  }
  const s = (zJug - zHip) / (zj - zh);
  const clamp = v => Math.min(1.25, Math.max(0.8, v));
  const sx = clamp(W / ((x1 - x0) * s)), sy = clamp(T / ((y1 - y0) * s));
  geo.translate(-(x0 + x1) / 2, -(y0 + y1) / 2, -zh);
  geo.scale(s * sx, s * sy, s);
  geo.translate(c.x, c.y, zHip);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

// Organe in natürlicher Farbe, beschnitten auf den Bereich lo…hi
const ORGAN_COLOR = { liver: 0x9b3b2b, kidney: 0xb5563c, spleen: 0x7c2c4c, heart: 0xc2463e, fluid: 0xe2cf72, lung: 0xe7a2a0 };
function organMaterial(k, lo, hi) {
  const planes = [0, 1, 2].flatMap(i => {
    const n = new THREE.Vector3().setComponent(i, 1);
    return [new THREE.Plane(n.clone(), -lo[i]), new THREE.Plane(n.clone().negate(), hi[i])];
  }).filter(pl => Math.abs(pl.constant) < 1e4);
  return new THREE.MeshStandardMaterial({
    color: ORGAN_COLOR[k], emissive: ORGAN_COLOR[k], emissiveIntensity: 0.25, roughness: 0.45,
    transparent: k === 'lung', opacity: k === 'lung' ? 0.75 : 1, depthTest: false, clippingPlanes: planes,
  });
}

const canvas = document.getElementById('c');
canvas.width = 480; canvas.height = 720;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080d);
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 5, 5000);
camera.up.set(0, 0, 1);   // Kopf oben im Bild, wie im Atlas

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const models = {}, metas = {};
let human = null;
async function model(name) {
  if (!models[name]) {
    models[name] = (await loader.loadAsync(`../data/${name}/anatomy.glb`)).scene;
    metas[name] = await (await fetch(`../data/${name}/meta.json`)).json();
  }
  return models[name];
}

async function render(win) {
  const root = await model(win.vol);
  const w = metas[win.vol].windows[win.key];
  const t = TARGET[win.key];
  const origin = new THREE.Vector3(...w.origin);
  const lo = [-1e5, -1e5, -1e5], hi = [1e5, 1e5, 1e5];
  ['x', 'y', 'z'].forEach((a, i) => { if (t.clip?.[a]) { lo[i] = origin.getComponent(i) + t.clip[a][0]; hi[i] = origin.getComponent(i) + t.clip[a][1]; } });
  root.traverse(o => {
    if (!o.isMesh) return;
    const k = o.name.replace(/_\d+$/, '');
    o.visible = true;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (k === 'artery' || k === 'vein') {
      o.material = new THREE.MeshBasicMaterial({ color: k === 'artery' ? 0xe0383a : 0xb02a50, transparent: true, opacity: 0.3, depthTest: false });
      o.renderOrder = 2;   // Gefäße fein im Hintergrund wie im Atlas
    } else if (t.keys.includes(k)) {
      o.material = organMaterial(k, lo, hi);
      o.renderOrder = 3;   // Zielorgan scheint durch die Haut
    } else o.visible = false;
  });
  scene.add(root);
  root.updateMatrixWorld(true);

  // Mensch einpassen: Landmarken aus dem CT (Hüfte am Beckenboden, Drosselgrube am Brustbein), die fehlende per Proportion
  const meshBox = key => { const b = new THREE.Box3(); root.traverse(o => { if (o.isMesh && o.name.startsWith(key)) b.expandByObject(o); }); return b; };
  const skinBox = meshBox('skin');
  const sc = skinBox.getCenter(new THREE.Vector3()), ss = skinBox.getSize(new THREE.Vector3());
  let zHip, zJug;
  if (win.vol === 'abdomen') { zHip = meshBox('pelvis').min.z + 40; zJug = zHip + 520; }
  else { zJug = meshBox('sternum').max.z; zHip = zJug - 520; }
  human ||= await loadHuman();
  const humanGeo = fitHuman(human, sc, ss.x, ss.y, zHip, zJug);
  const fig = shell(humanGeo);
  scene.add(fig);

  // Sonde an der Haut: von außen entlang der Schallrichtung bis zur Haut
  const L = new THREE.Vector3(...w.L), D = new THREE.Vector3(...w.D), E = new THREE.Vector3(...w.E);
  const ray = new THREE.Raycaster(origin.clone().addScaledVector(D, -300), D.clone());
  const skinHit = new THREE.Mesh(humanGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const hit = ray.intersectObject(skinHit, false)[0];
  const o = hit ? hit.point : origin;

  // Sonde und Fächer anderthalbfach, damit sie im Ganzkörperbild gut zu sehen sind
  const basis = new THREE.Matrix4().makeBasis(L, D, E).multiply(new THREE.Matrix4().makeScale(1.5, 1.5, 1.5)).setPosition(o);
  const probe = probeMesh(win.hint);
  probe.traverse(m => {
    if (!m.isMesh) return;
    if (m.geometry.type === 'TubeGeometry') { m.visible = false; return; }   // Kabel weglassen, lenkt nur ab
    const isMarker = m.geometry.type === 'SphereGeometry';
    if (isMarker) m.scale.setScalar(3);
    m.material = new THREE.MeshStandardMaterial({
      color: isMarker ? 0x4fd18b : 0xff9a2e, emissive: isMarker ? 0x2fd17b : 0x6a2c00, roughness: 0.45,
    });
    m.renderOrder = 5;
  });
  probe.matrixAutoUpdate = false;
  probe.matrix.copy(basis);
  scene.add(probe);

  // Schallebene: halbdurchsichtiger Fächer in Orange
  const pts = fanShape(win.hint, 110);
  const fanGeo = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
  const fan = new THREE.Group();
  fan.add(new THREE.Mesh(fanGeo, new THREE.MeshBasicMaterial({
    color: 0xff9a2e, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  })));
  fan.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0))),
    new THREE.LineBasicMaterial({ color: 0xffb460 })));
  fan.matrixAutoUpdate = false;
  fan.matrix.copy(basis);
  fan.traverse(m => { m.renderOrder = 4; if (m.material) m.material.depthTest = false; });   // Ebene liegt im Körper
  scene.add(fan);

  // Kamera schräg von vorn: Flanken von der Sondenseite, sonst nahe der Ebenennormalen, damit der Fächer sichtbar ist.
  // Ganzer Mensch im Bild
  let dir;
  if (win.key === 'ruq' || win.key === 'luq') {
    dir = D.clone().negate().setZ(0).multiplyScalar(0.35).add(new THREE.Vector3(0, 1, 0.3)).normalize();   // Sonde ragt seitlich heraus, im Profil sichtbar
  } else if (win.key === 'pelvis' || win.key === 'subxiphoid') {
    dir = new THREE.Vector3(0.45, 1, 0.12).normalize();
  } else {
    const front = new THREE.Vector3(0, 1, 0.2);
    const n = E.clone().multiplyScalar(Math.sign(E.dot(front)) || 1);
    dir = front.normalize().multiplyScalar(1.2).add(n).normalize();
  }
  const hb = humanGeo.boundingBox;
  const zTop = hb.max.z + 20, zBot = hb.min.z - 20;
  const target = new THREE.Vector3(sc.x, sc.y, (zTop + zBot) / 2);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitW = (hb.max.x - hb.min.x) / 2 / camera.aspect;
  camera.position.copy(target).addScaledVector(dir, Math.max((zTop - zBot) / 2, fitW) * 1.1 / Math.tan(fov / 2) + ss.y / 2);
  camera.lookAt(target);
  sun.position.copy(camera.position);

  renderer.render(scene, camera);
  const url = canvas.toDataURL('image/webp', 0.86);
  scene.remove(root, probe, fan, fig);
  return url;
}

window.renderAll = async () => {
  const out = {};
  for (const win of WINDOWS) out[win.key] = await render(win);
  return out;
};
window.ready = true;
