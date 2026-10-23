// Halte-Bilder im Röntgen-Look: Rumpf aus dem CT mit angedeutetem Kopf, Schultern und Hüften, Skelett zart,
// nur das Zielorgan leuchtet, Sonde in Kontrastfarbe an der Standardlage aus meta.json, Schallebene angedeutet.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { WINDOWS } from '../js/common.js';
import { probeMesh, fanShape } from '../js/anatomy3d.js';

// Zielorgane je Fenster; clip begrenzt auf einen Teil des Modells (Harnblase hängt mit der Gallenblase zusammen,
// die Lunge ist ein Modell für beide Seiten). Grenzen relativ zur Sondenposition in mm.
const BONES = ['ribs', 'spine', 'sternum', 'pelvis'];
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
const SKIN = 0x2a86ff;
function shell(geo, opts = {}) {
  const depth = holo(SKIN, 0, 0, 1, opts);
  Object.assign(depth, { colorWrite: false, depthWrite: true, transparent: false, blending: THREE.NormalBlending });
  const glow = holo(SKIN, 0.03, 0.95, 2.3, opts);
  glow.depthFunc = THREE.LessEqualDepth;
  const g = new THREE.Group();
  const d = new THREE.Mesh(geo, depth), c = new THREE.Mesh(geo, glow);
  d.renderOrder = 0; c.renderOrder = 1;
  g.add(d, c);
  return g;
}

// Kopf aus einer verformten Kugel: Hinterkopf, Stirn, Nase, Kinn, damit vorn auf einen Blick klar ist
function headGeometry() {
  const geo = new THREE.SphereGeometry(1, 96, 64);
  const p = geo.attributes.position, v = new THREE.Vector3();
  const bump = (n, dir, w, a) => a * Math.exp(-(1 - n.dot(dir)) / w);
  const nose = new THREE.Vector3(0, 0.97, -0.25).normalize(), chin = new THREE.Vector3(0, 0.6, -0.8).normalize();
  const brow = new THREE.Vector3(0, 0.8, 0.35).normalize(), back = new THREE.Vector3(0, -0.6, 0.5).normalize();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    let r = 1 + bump(n, nose, 0.006, 0.28) + bump(n, chin, 0.03, 0.1) + bump(n, brow, 0.04, 0.05) + bump(n, back, 0.15, 0.08);
    if (n.z < -0.2) r *= 1 - 0.18 * (-n.z - 0.2) * (1 - Math.abs(n.y)) ;   // Kiefer schmaler
    v.copy(n).multiplyScalar(r);
    p.setXYZ(i, v.x * 76, v.y * 92, v.z * 112);
  }
  geo.computeVertexNormals();
  return geo;
}

// Angedeuteter Körper um den CT-Rumpf: Rumpf außerhalb des CT, Hals, Kopf mit Gesicht nach vorn,
// Schultern mit kurz auslaufenden Oberarmen, Ansatz der Oberschenkel. zHip = Hüftgelenk, zJug = Drosselgrube.
function body(c, W, T, zHip, zJug, ctZ) {
  const g = new THREE.Group();
  const prof = [[0, zHip - 120], [0.78, zHip - 110], [0.95, zHip - 40], [0.97, zHip + 70], [0.88, zHip + 210],
    [0.95, zHip + 330], [1.0, zJug - 120], [1.04, zJug - 50], [0.9, zJug - 5], [0.45, zJug + 30], [0.3, zJug + 40], [0, zJug + 42]];
  const torso = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 64);
  torso.rotateX(Math.PI / 2);
  torso.scale(W / 2, T / 2, 1);
  torso.translate(c.x, c.y, 0);
  // CT-Bereich aussparen: unterer und oberer Teil getrennt; unten zu den Beinen hin ausblenden
  const hipC = [c.x, c.y, zHip];
  g.add(shell(torso, { max: [1e5, 1e5, ctZ[0] + 15], fade: { c: [c.x, c.y, zHip + 150], r: [180, 420] } }));
  g.add(shell(torso, { min: [-1e5, -1e5, ctZ[1] - 15] }));
  const y0 = c.y - 0.06 * T;
  const neck = new THREE.CylinderGeometry(52, 58, 150, 40, 1, true).rotateX(Math.PI / 2).translate(c.x, y0, zJug + 55);
  g.add(shell(neck));
  g.add(shell(headGeometry().translate(c.x, y0 + 12, zJug + 225)));
  const limb = (a, b, ra, rb, fade) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const geo = new THREE.CylinderGeometry(rb, ra, A.distanceTo(B), 32, 1, true);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    geo.translate(...A.clone().add(B).multiplyScalar(0.5).toArray());
    g.add(shell(geo, { fade }));
    g.add(shell(new THREE.SphereGeometry(ra, 32, 20).translate(A.x, A.y, A.z), { fade }));
  };
  for (const s of [1, -1]) {
    const sh = [c.x + s * (W / 2 - 10), y0, zJug - 55];
    limb(sh, [c.x + s * (W / 2 + 120), y0 - 10, zJug - 330], 52, 42, { c: sh, r: [90, 260] });   // Oberarm, leicht abgespreizt
    const hip = [c.x + s * 0.24 * W, c.y, zHip - 30];
    limb(hip, [c.x + s * 0.23 * W, c.y + 10, zHip - 460], 92, 60, { c: hipC, r: [120, 330] });   // Oberschenkel
  }
  return g;
}

const canvas = document.getElementById('c');
canvas.width = 640; canvas.height = 640;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 5, 5000);
camera.up.set(0, 0, 1);   // Kopf oben im Bild, wie im Atlas

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const models = {}, metas = {};
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
  const skinGeos = [];   // Haut-Meshes des CT, werden als Hülle neu gezeichnet
  root.traverse(o => {
    if (!o.isMesh) return;
    const k = o.name.replace(/_\d+$/, '');
    o.visible = true;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (k === 'skin') { o.visible = false; skinGeos.push(o); }
    else if (BONES.includes(k)) {
      o.material = holo(0x5aa8ff, 0.015, 0.32, 1.8);   // Skelett nur zart zur Orientierung
      o.material.depthTest = false;
      o.renderOrder = 2;
    } else if (t.keys.includes(k)) {
      o.material = holo(0xa6ecff, k === 'lung' ? 0.08 : 0.22, 1.0, 1.3, { min: lo, max: hi });
      o.material.depthTest = false;   // Zielorgan leuchtet durch die Haut
      o.renderOrder = 3;
    } else o.visible = false;
  });
  scene.add(root);
  root.updateMatrixWorld(true);

  // Körper ergänzen: Landmarken aus dem CT (Hüfte am Beckenboden, Drosselgrube am Brustbein), die fehlende per Proportion
  const meshBox = key => { const b = new THREE.Box3(); root.traverse(o => { if (o.isMesh && o.name.startsWith(key)) b.expandByObject(o); }); return b; };
  const skinBox = meshBox('skin');
  const sc = skinBox.getCenter(new THREE.Vector3()), ss = skinBox.getSize(new THREE.Vector3());
  let zHip, zJug;
  if (win.vol === 'abdomen') { zHip = meshBox('pelvis').min.z + 40; zJug = zHip + 520; }
  else { zJug = meshBox('sternum').max.z; zHip = zJug - 520; }
  const fig = body(sc, ss.x, ss.y, zHip, zJug, [skinBox.min.z, skinBox.max.z]);
  for (const m of skinGeos) {
    // Geometrie ist quantisiert (Meshopt), daher Weltlage als Matrix übernehmen statt umzurechnen
    const sh = shell(m.geometry);
    sh.matrixAutoUpdate = false;
    sh.matrix.copy(m.matrixWorld);
    fig.add(sh);
  }
  scene.add(fig);

  // Sonde an der Haut: von außen entlang der Schallrichtung bis zur Haut
  const L = new THREE.Vector3(...w.L), D = new THREE.Vector3(...w.D), E = new THREE.Vector3(...w.E);
  const skin = [];
  root.traverse(o => { if (o.isMesh && o.name.startsWith('skin')) skin.push(o); });
  const ray = new THREE.Raycaster(origin.clone().addScaledVector(D, -200), D.clone());
  skin.forEach(m => { m.visible = true; });
  const hit = ray.intersectObjects(skin, false)[0];
  skin.forEach(m => { m.visible = false; });
  const o = hit ? hit.point : origin;

  const basis = new THREE.Matrix4().makeBasis(L, D, E).setPosition(o);
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
  // Bildausschnitt vom Scheitel bis zu den Hüften
  let dir;
  if (win.key === 'ruq' || win.key === 'luq') {
    dir = D.clone().negate().setZ(0).multiplyScalar(0.35).add(new THREE.Vector3(0, 1, 0.3)).normalize();   // Sonde ragt seitlich heraus, im Profil sichtbar
  } else if (win.key === 'pelvis') {
    dir = new THREE.Vector3(0.55, 1, 0.35).normalize();
  } else {
    const front = new THREE.Vector3(0, 1, 0.2);
    const n = E.clone().multiplyScalar(Math.sign(E.dot(front)) || 1);
    dir = front.normalize().multiplyScalar(1.2).add(n).normalize();
  }
  const zTop = zJug + 345, zBot = zHip - 140;
  const target = new THREE.Vector3(sc.x, sc.y, (zTop + zBot) / 2);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  camera.position.copy(target).addScaledVector(dir, (zTop - zBot) * 0.52 / Math.tan(fov / 2) + ss.y / 2);
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
