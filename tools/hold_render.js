// Halte-Bilder im Röntgen-Look: durchscheinende Haut, Skelett, nur die wichtigen Organe des Fensters,
// Sonde in Kontrastfarbe an der Standardlage aus meta.json, Schallebene angedeutet.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { WINDOWS } from '../js/common.js';
import { probeMesh, fanShape } from '../js/anatomy3d.js';

// Organe, die im jeweiligen Fenster wichtig sind, hervorgehoben
const KEY_ORGANS = {
  ruq: ['liver', 'kidney'],
  luq: ['spleen', 'kidney'],
  subxiphoid: ['heart', 'liver'],
  pelvis: ['fluid'],
  lung_r: ['lung'],
  lung_l: ['lung'],
};
const BONES = ['ribs', 'spine', 'sternum', 'pelvis', 'cartilage'];

// Fresnel-Glühen: Ränder hell, Flächen fast durchsichtig, additiv wie ein Röntgenbild
function holo(color, base, rim, power = 2.5) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uBase: { value: base }, uRim: { value: rim }, uPow: { value: power } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uBase, uRim, uPow; varying vec3 vN; varying vec3 vV;
      void main() { float r = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uColor * (uBase + uRim * pow(r, uPow)), 1.0); }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 5, 5000);
camera.up.set(0, 0, 1);

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
  const keys = KEY_ORGANS[win.key];
  root.traverse(o => {
    if (!o.isMesh) return;
    const k = o.name.replace(/_\d+$/, '');
    o.visible = true;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (k === 'skin') o.material = holo(0x1e78ff, 0.015, 0.55, 2.2);
    else if (BONES.includes(k)) o.material = holo(0x6fb6ff, 0.05, 0.5, 1.6);
    else if (keys.includes(k)) o.material = k === 'lung' ? holo(0x9fe8ff, 0.05, 0.7, 1.6) : holo(0x9fe8ff, 0.16, 0.9, 1.4);
    else o.visible = false;
    o.renderOrder = 1;
  });
  scene.add(root);
  root.updateMatrixWorld(true);
  // Harnblase und Gallenblase teilen sich ein Modell: nur den Teil in der Nähe des Fensters zeigen
  const near = new THREE.Vector3(...w.origin);
  root.traverse(o => {
    if (o.isMesh && o.visible && o.name.startsWith('fluid')) {
      const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      if (c.distanceTo(near) > 150) o.visible = false;
    }
  });

  // Sonde an der Haut: von außen entlang der Schallrichtung bis zur Haut
  const L = new THREE.Vector3(...w.L), D = new THREE.Vector3(...w.D), E = new THREE.Vector3(...w.E);
  const origin = new THREE.Vector3(...w.origin);
  const skin = [];
  root.traverse(o => { if (o.isMesh && o.name.startsWith('skin')) skin.push(o); });
  const ray = new THREE.Raycaster(origin.clone().addScaledVector(D, -200), D.clone());
  const hit = ray.intersectObjects(skin, false)[0];
  const o = hit ? hit.point : origin;

  const basis = new THREE.Matrix4().makeBasis(L, D, E).setPosition(o);
  const probe = probeMesh(win.hint);
  probe.traverse(m => {
    if (!m.isMesh) return;
    if (m.geometry.type === 'TubeGeometry') { m.visible = false; return; }   // Kabel weglassen, lenkt nur ab
    const isMarker = m.geometry.type === 'SphereGeometry';
    if (isMarker) m.scale.setScalar(2.2);
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
  fan.traverse(m => { m.renderOrder = 4; });
  scene.add(fan);

  // Kamera: schräg von vorn auf der Seite, von der die Sonde kommt, ganzer Rumpf im Bild
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  // Flanken schräg von vorn auf der Sondenseite, sonst wie die 3D-Ansicht: nahe der Ebenennormalen, damit der Fächer sichtbar ist
  let dir;
  if (win.key === 'ruq' || win.key === 'luq') {
    dir = D.clone().negate().setZ(0).multiplyScalar(0.9).add(new THREE.Vector3(0, 1, 0.45)).normalize();
  } else if (win.key === 'pelvis') {
    dir = new THREE.Vector3(0.55, 1, 0.5).normalize();   // schräg von vorn oben rechts, Blase und Fächer im Profil
  } else {
    const front = new THREE.Vector3(0, 1, 0.35);
    const n = E.clone().multiplyScalar(Math.sign(E.dot(front)) || 1);
    dir = front.normalize().multiplyScalar(1.1).add(n).normalize();
  }
  const target = center.clone().lerp(o, 0.35);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = Math.max(size.z, size.x / camera.aspect) * 0.62 / Math.tan(fov / 2) + size.y / 2;
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.lookAt(target);
  sun.position.copy(camera.position);

  renderer.render(scene, camera);
  const url = canvas.toDataURL('image/webp', 0.86);
  scene.remove(root, probe, fan);
  return url;
}

window.renderAll = async () => {
  const out = {};
  for (const win of WINDOWS) out[win.key] = await render(win);
  return out;
};
window.ready = true;
