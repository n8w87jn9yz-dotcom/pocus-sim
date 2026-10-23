// Halte-Bilder im Röntgen-Look: ganzer liegender Mensch (Rumpf aus dem CT, Kopf, Arme und Beine stilisiert),
// nur das Zielorgan leuchtet, Sonde in Kontrastfarbe an der Standardlage aus meta.json, Schallebene angedeutet.
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
// Fragmente außerhalb von uMin…uMax (Weltkoordinaten) fallen weg.
function holo(color, base, rim, power = 2.5, min = [-1e5, -1e5, -1e5], max = [1e5, 1e5, 1e5]) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uBase: { value: base }, uRim: { value: rim }, uPow: { value: power },
      uMin: { value: new THREE.Vector3(...min) }, uMax: { value: new THREE.Vector3(...max) },
    },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vW = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor, uMin, uMax; uniform float uBase, uRim, uPow; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        if (any(lessThan(vW, uMin)) || any(greaterThan(vW, uMax))) discard;
        float r = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uColor * (uBase + uRim * pow(r, uPow)), 1.0); }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// Körperhülle: erst nur Tiefe schreiben, dann nur die vorderste Fläche als Fresnel-Glühen zeichnen.
// So verschmelzen überlappende Teile (Rumpf, Arme, Beine) zu einer glatten Silhouette ohne innere Linien.
const SKIN = 0x1e78ff;
function shell(geo, lo, hi) {
  const depth = holo(SKIN, 0, 0, 1, lo, hi);
  Object.assign(depth, { colorWrite: false, depthWrite: true, transparent: false, blending: THREE.NormalBlending });
  const glow = holo(SKIN, 0.09, 1.7, 2.0, lo, hi);
  glow.depthFunc = THREE.LessEqualDepth;
  const g = new THREE.Group();
  const d = new THREE.Mesh(geo, depth), c = new THREE.Mesh(geo, glow);
  d.renderOrder = 0; c.renderOrder = 1;
  g.add(d, c);
  return g;
}

// Stilisierter Körper um den CT-Rumpf: Kopf mit Nase, Hals, Arme leicht abgespreizt, Beine mit Füßen nach vorn.
// zHip = Hüftgelenk, zJug = Drosselgrube; der Rumpf wird nur außerhalb des CT-Bereichs gezeichnet.
function mannequin(c, W, T, zHip, zJug, ctZ) {
  const g = new THREE.Group();
  const add = geo => g.add(shell(geo));
  // Glied als Kegelstumpf mit Kugeln an beiden Enden
  const limb = (a, b, ra, rb) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const geo = new THREE.CylinderGeometry(rb, ra, A.distanceTo(B), 32, 1, true);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    geo.translate(...A.clone().add(B).multiplyScalar(0.5).toArray());
    add(geo);
    for (const [P, r] of [[A, ra], [B, rb]]) add(new THREE.SphereGeometry(r, 32, 20).translate(P.x, P.y, P.z));
  };
  const prof = [[0, zHip - 120], [0.78, zHip - 110], [0.95, zHip - 40], [0.97, zHip + 70], [0.88, zHip + 210],
    [0.95, zHip + 330], [1.0, zJug - 120], [1.02, zJug - 40], [0.8, zJug + 15], [0.3, zJug + 40], [0, zJug + 42]];
  const torso = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 64);
  torso.rotateX(Math.PI / 2);
  torso.scale(W / 2, T / 2, 1);
  torso.translate(c.x, c.y, 0);
  // CT-Bereich aussparen: unterer und oberer Teil getrennt
  g.add(shell(torso, [-1e5, -1e5, -1e5], [1e5, 1e5, ctZ[0] + 15]));
  g.add(shell(torso, [-1e5, -1e5, ctZ[1] - 15], [1e5, 1e5, 1e5]));
  const y0 = c.y - 0.08 * T;
  limb([c.x, y0, zJug - 10], [c.x, y0, zJug + 130], 55, 50);   // Hals
  add(new THREE.SphereGeometry(1, 48, 32).scale(82, 98, 118).translate(c.x, y0 + 10, zJug + 235));   // Kopf
  add(new THREE.ConeGeometry(20, 48, 24).translate(c.x, y0 + 10 + 112, zJug + 222));   // Nase, Spitze nach vorn (+y)
  for (const s of [1, -1]) {
    const sh = [c.x + s * (W / 2 - 5), y0, zJug - 50];
    const el = [c.x + s * (W / 2 + 150), y0 - 10, zJug - 300];
    const wr = [c.x + s * (W / 2 + 290), y0, zJug - 530];
    limb(sh, el, 50, 40); limb(el, wr, 40, 30);
    add(new THREE.SphereGeometry(1, 24, 16).scale(30, 18, 60).translate(wr[0] + s * 12, wr[1], wr[2] - 60));   // Hand
    const hip = [c.x + s * 0.23 * W, c.y, zHip - 30];
    const knee = [c.x + s * 0.22 * W, c.y + 10, zHip - 460];
    const ankle = [c.x + s * 0.2 * W, c.y - 10, zHip - 870];
    limb(hip, knee, 88, 55); limb(knee, ankle, 55, 35);
    limb([ankle[0], ankle[1] - 25, ankle[2] - 25], [ankle[0], ankle[1] + 160, ankle[2] - 35], 36, 30);   // Fuß zeigt nach vorn
  }
  return g;
}

const canvas = document.getElementById('c');
canvas.width = 960; canvas.height = 480;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 5, 5000);
camera.up.set(0, 1, 0);   // Patient liegt auf dem Rücken: vorn ist oben im Bild

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
    else if (t.keys.includes(k)) {
      o.material = holo(0xa6ecff, k === 'lung' ? 0.08 : 0.22, 1.0, 1.3, lo, hi);
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
  const body = mannequin(sc, ss.x, ss.y, zHip, zJug, [skinBox.min.z, skinBox.max.z]);
  for (const m of skinGeos) {
    // Geometrie ist quantisiert (Meshopt), daher Weltlage als Matrix übernehmen statt umzurechnen
    const sh = shell(m.geometry);
    sh.matrixAutoUpdate = false;
    sh.matrix.copy(m.matrixWorld);
    body.add(sh);
  }
  scene.add(body);

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

  // Kamera von der Seite der Sonde (bei mittigen Fenstern von rechts) und schräg von oben auf den liegenden Menschen
  const side = (win.key === 'luq' || win.key === 'lung_l') ? -1 : 1;
  const dir = new THREE.Vector3(side, win.key.endsWith('uq') ? 1.2 : 0.8, 0).normalize();
  const zTop = zJug + 360, zFoot = zHip - 900;
  const target = new THREE.Vector3(sc.x, sc.y, (zTop + zFoot) / 2);
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
  camera.position.copy(target).addScaledVector(dir, (zTop - zFoot) * 0.5 / Math.tan(hfov / 2) + ss.x / 2);
  camera.lookAt(target);
  sun.position.copy(camera.position);

  renderer.render(scene, camera);
  const url = canvas.toDataURL('image/webp', 0.86);
  scene.remove(root, probe, fan, body);
  return url;
}

window.renderAll = async () => {
  const out = {};
  for (const win of WINDOWS) out[win.key] = await render(win);
  return out;
};
window.ready = true;
