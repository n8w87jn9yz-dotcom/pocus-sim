// 3D-Anatomieansicht: Oberflächenmodelle aus demselben CT wie das Ultraschallbild, Sonde und Schallebene.
// Koordinaten wie im Volumen: mm, RAS (x = rechts, y = anterior, z = kranial).
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from '../vendor/three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js';

// Farben und Oberflächen angelehnt an anatomische Atlanten.
// bump: Stärke der Oberflächenstruktur, scale: Größe in mm, fiber: Muskelfasern (längs gestreckt), vary: Farbschwankung
const LOOK = {
  skin: { color: 0xf0cdb8, skin: true },
  muscle: { color: 0x7d1b18, roughness: 0.5, clearcoat: 0.35, sheen: 0, bump: 1.4, scale: 1.4, fiber: true, vary: 0.3 },
  bone: { color: 0xe9e0c9, roughness: 0.6, bump: 0.35, scale: 2.5, vary: 0.12 },
  ribs: 'bone', spine: 'bone', sternum: 'bone', pelvis: 'bone',
  cartilage: { color: 0xc4d4d0, roughness: 0.35, clearcoat: 0.5, vary: 0.08, opacity: 0.85 },
  lung: { color: 0xe3a09e, roughness: 0.55, bump: 0.5, scale: 3, vary: 0.2, opacity: 0.5 },
  liver: { color: 0x7e2219, roughness: 0.3, clearcoat: 0.8, bump: 0.15, scale: 6, vary: 0.15 },
  spleen: { color: 0x66203a, roughness: 0.3, clearcoat: 0.8, bump: 0.15, scale: 5, vary: 0.15 },
  kidney: { color: 0x963a2a, roughness: 0.3, clearcoat: 0.8, bump: 0.12, scale: 5, vary: 0.12 },
  heart: { color: 0xa8322b, roughness: 0.35, clearcoat: 0.6, bump: 0.4, scale: 2.2, fiber: true, vary: 0.2 },
  bowel: { color: 0xd0927a, roughness: 0.35, clearcoat: 0.6, bump: 0.3, scale: 3, vary: 0.18 },
  fluid: { color: 0xd9c66b, roughness: 0.2, clearcoat: 1, vary: 0.08, opacity: 0.85 },
  artery: { color: 0xc8161d, roughness: 0.28, clearcoat: 0.9, vary: 0.08 },
  vein: { color: 0x2c4fae, roughness: 0.28, clearcoat: 0.9, vary: 0.08 },
};

const NAMES = {
  skin: 'Haut', muscle: 'Rumpfwandmuskulatur', bone: 'Knochen', ribs: 'Rippen', spine: 'Wirbelsäule',
  sternum: 'Brustbein (Sternum)', pelvis: 'Becken', cartilage: 'Rippenknorpel', lung: 'Lunge',
  liver: 'Leber', spleen: 'Milz', kidney: 'Niere', heart: 'Herz', bowel: 'Magen und Darm',
  fluid: 'Harnblase / Gallenblase', artery: 'Aorta und Arterien', vein: 'V. cava und Venen',
};

// Ebenen wie im Atlas, einzeln ein- und ausblendbar
export const LAYERS = [
  { id: 'skin', name: 'Haut', keys: ['skin'], on: true },
  { id: 'muscle', name: 'Muskeln', keys: ['muscle'], on: false },
  { id: 'bone', name: 'Skelett', keys: ['ribs', 'spine', 'sternum', 'pelvis', 'cartilage'], on: true },
  { id: 'lung', name: 'Lunge', keys: ['lung'], on: true },
  { id: 'organs', name: 'Organe', keys: ['liver', 'spleen', 'kidney', 'heart', 'bowel', 'fluid'], on: true },
  { id: 'vessels', name: 'Gefäße', keys: ['artery', 'vein'], on: true },
];

// GLSL: Rauschen im Raum (mm) für Oberflächenstruktur und Farbschwankung
const NOISE = `
varying vec3 vWPos;
uniform float uBump, uScale, uVary, uFiber;
uniform vec3 uHighlight;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.15 * vnoise(p * 4.1 + 3.3); }
float surfH(vec3 p) {
  vec3 q = p / uScale;
  if (uFiber > 0.5) q *= vec3(1.0, 1.0, 0.18);   // Fasern grob kraniokaudal
  return fbm(q);
}
vec3 bumpN(vec3 pos, vec3 n, float h) {
  vec3 dx = dFdx(pos), dy = dFdy(pos);
  vec3 r1 = cross(dy, n), r2 = cross(n, dx);
  float det = dot(dx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - g);
}
`;

function material(key) {
  let l = LOOK[key] || { color: 0x999999 };
  if (typeof l === 'string') l = LOOK[l];
  if (l.skin) {
    // Haut als Glashülle: in der Mitte fast durchsichtig, zum Rand hin deckend (Fresnel).
    // An den Enden des CT läuft sie weich aus, statt hart abzuschneiden.
    const m = new THREE.MeshPhysicalMaterial({
      color: l.color, roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(0xffe0d0),
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    m.userData.zRange = { value: new THREE.Vector2(0, 1) };
    m.onBeforeCompile = s => {
      s.uniforms.uZRange = m.userData.zRange;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZ = (modelMatrix * vec4(transformed, 1.0)).z;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vZ;\nuniform vec2 uZRange;')
        .replace('#include <opaque_fragment>', `
        float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
        float fade = smoothstep(uZRange.x, uZRange.x + 45.0, vZ) * (1.0 - smoothstep(uZRange.y - 45.0, uZRange.y, vZ));
        diffuseColor.a = mix(0.04, 0.42, pow(rim, 3.0)) * fade;
        #include <opaque_fragment>`);
    };
    return m;
  }
  const m = new THREE.MeshPhysicalMaterial({
    color: l.color, roughness: l.roughness ?? 0.5, metalness: 0, clearcoat: l.clearcoat ?? 0,
    clearcoatRoughness: 0.3, sheen: l.sheen ?? 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff),
    transparent: l.opacity !== undefined, opacity: l.opacity ?? 1, depthWrite: l.opacity === undefined,
  });
  m.userData.highlight = { value: new THREE.Color(0, 0, 0) };
  m.onBeforeCompile = s => {
    Object.assign(s.uniforms, {
      uBump: { value: l.bump ?? 0 }, uScale: { value: l.scale ?? 4 }, uVary: { value: l.vary ?? 0 },
      uFiber: { value: l.fiber ? 1 : 0 }, uHighlight: m.userData.highlight,
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hS = surfH(vWPos);
        diffuseColor.rgb *= 1.0 + uVary * (fbm(vWPos / (uScale * 6.0)) - 0.5) * 2.0;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (uBump > 0.0) normal = bumpN(-vViewPosition, normal, hS * uBump);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uHighlight;`);
  };
  return m;
}

// Schallkopf: Umriss in der Ebene L (x) / D (y), entlang E extrudiert und abgerundet.
// Lauffläche bei y = 0, Griff nach außen (negatives y), Marker auf der Seite, die im Bild links liegt (-L).
const PROBE = {
  convex: { foot: 60, thick: 20, curve: 40, neck: 30, grip: 34, len: 125 },
  linear: { foot: 44, thick: 14, curve: 0, neck: 26, grip: 30, len: 120 },
  phased: { foot: 24, thick: 18, curve: 0, neck: 26, grip: 32, len: 115 },
};
function probeMesh(kind) {
  const p = PROBE[kind];
  const g = new THREE.Group();
  const shell = new THREE.MeshPhysicalMaterial({ color: 0xeef1f5, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x22272e, roughness: 0.55 });
  const accent = new THREE.MeshPhysicalMaterial({ color: 0x4fb3ff, roughness: 0.3, emissive: 0x123a5c });
  const hw = p.foot / 2, bevel = 3;
  const s = new THREE.Shape();
  const footY = x => (p.curve ? -p.curve + Math.sqrt(p.curve * p.curve - x * x) : 0);
  s.moveTo(-hw, footY(hw) - 1);
  for (let i = 1; i <= 16; i++) { const x = -hw + (p.foot * i) / 16; s.lineTo(x, footY(x)); }
  s.bezierCurveTo(hw + 2, -14, p.neck / 2 + 4, -26, p.neck / 2, -38);
  s.bezierCurveTo(p.grip / 2, -55, p.grip / 2, -p.len + 20, p.grip / 2 - 4, -p.len);
  s.quadraticCurveTo(0, -p.len - 8, -p.grip / 2 + 4, -p.len);
  s.bezierCurveTo(-p.grip / 2, -p.len + 20, -p.grip / 2, -55, -p.neck / 2, -38);
  s.bezierCurveTo(-p.neck / 2 - 4, -26, -hw - 2, -14, -hw, footY(hw) - 1);
  const depth = p.thick - 2 * bevel;
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel - 0.5, bevelSegments: 5, curveSegments: 24,
  }), shell);
  body.position.z = -depth / 2;
  // Linse an der Lauffläche
  const lens = new THREE.Mesh(new THREE.BoxGeometry(p.foot * 0.9, 2.2, p.thick * 0.7), dark);
  lens.position.y = footY(0) - 1.2 + (p.curve ? -1 : 0);
  // Orientierungsmarker: Leuchtpunkt auf der -L-Seite
  const marker = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 12), accent);
  marker.position.set(-hw - 0.5, -10, 0);
  // Kabel als Schlauch, leicht durchhängend
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -p.len - 4, 0), new THREE.Vector3(0, -p.len - 40, 0),
    new THREE.Vector3(10, -p.len - 110, 20), new THREE.Vector3(30, -p.len - 200, 60),
  ]);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 3.2, 12), dark);
  const strain = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6.5, 18, 20), dark);
  strain.position.y = -p.len - 8;
  g.add(body, lens, marker, cable, strain);
  return g;
}

// Umriss des Schallfächers in der Ebene L (x) / D (y) des Sondensystems, in mm
function fanShape(kind, depthMm) {
  const pts = [];
  if (kind === 'linear') {
    pts.push([-20, 0], [20, 0], [20, depthMm], [-20, depthMm]);
  } else {
    const [r0, a, c] = kind === 'convex' ? [40, 0.62, -40] : [0.01, 0.78, 0];
    for (let i = 0; i <= 32; i++) { const t = -a + (2 * a * i) / 32; pts.push([Math.sin(t) * (r0 + depthMm), c + Math.cos(t) * (r0 + depthMm)]); }
    for (let i = 32; i >= 0; i -= kind === 'convex' ? 1 : 32) { const t = -a + (2 * a * i) / 32; pts.push([Math.sin(t) * r0, c + Math.cos(t) * r0]); }
  }
  return pts;
}
// Schallebene mit dem Ultraschallbild als Textur und blauem Rand
// Polygon auf den Streifen |x| <= half beschneiden (Sutherland-Hodgman), wie der sichtbare Bildausschnitt
function clipX(pts, half) {
  let out = pts;
  for (const side of [1, -1]) {
    const inp = out; out = [];
    const inside = p => side * p[0] <= half;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const t = (side * half - a[0]) / (b[0] - a[0]);
        out.push([side * half, a[1] + t * (b[1] - a[1])]);
      }
    }
  }
  return out;
}
function fanMesh(kind, depthMm, topMm, wMm, tex) {
  // Der Fächer wird so breit gezeigt wie das Ultraschallbild auf dem Monitor
  const pts = clipX(fanShape(kind, depthMm), wMm / 2 - 0.5);
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), 48);
  // UV wie im Ultraschallbild: v = 1 oben (Tiefe -topMm), u über die Breite des Canvas
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5 + pos.getX(i) / wMm, 1 - (pos.getY(i) + topMm) / (depthMm + topMm));
  const grp = new THREE.Group();
  const plane = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.97, depthWrite: false, depthTest: false,
    toneMapped: false,
  }));
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0))),
    new THREE.LineBasicMaterial({ color: 0x4fb3ff, transparent: true, opacity: 0.9, depthTest: false }));
  plane.renderOrder = edge.renderOrder = 20;
  grp.add(plane, edge);
  grp.userData.dispose = () => { g.dispose(); edge.geometry.dispose(); };
  return grp;
}

// Hintergrund wie im Atlas: weicher Verlauf
function backdrop() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const ctx = c.getContext('2d');
  const gr = ctx.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#4a5868'); gr.addColorStop(0.55, '#232c37'); gr.addColorStop(1, '#0d1218');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 16, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Anatomy3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.background = backdrop();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    // Lichtführung wie im Fotostudio: Hauptlicht schräg oben, kühles Gegenlicht, Aufhellung
    const key = new THREE.DirectionalLight(0xfff4ea, 2.2);
    key.position.set(-0.5, 0.9, 1);
    const rim = new THREE.DirectionalLight(0xa8c8ff, 1.4);
    rim.position.set(0.6, -0.8, 0.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(0.3, 1, -0.3);
    this.scene.add(key, rim, fill, new THREE.HemisphereLight(0xdde8ff, 0x302820, 0.35));
    this.camera = new THREE.PerspectiveCamera(30, 1, 5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.models = {};
    this.current = null;
    this.probe = null;
    this.probeKind = null;
    this.fan = null;
    this.showFan = true;
    this.usTex = null;
    this.layers = Object.fromEntries(LAYERS.map(l => [l.id, l.on]));
    this.selected = null;
    this.composer = null;
    this.initPicking();
  }

  // Ambient Occlusion (GTAO) für plastische Tiefe in Spalten und Mulden, 4-fach Kantenglättung
  initComposer(w, h) {
    try {
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(this.renderer, rt);
      c.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, w, h);
      ao.updateGtaoMaterial({ radius: 18, distanceExponent: 1.5, thickness: 6, scale: 1.2, samples: 12 });
      ao.blendIntensity = 0.85;
      // Durchsichtige Hüllen (Haut, Lunge) und Schallebene werfen keine Verschattung
      const base = ao.overrideVisibility.bind(ao);
      ao.overrideVisibility = () => {
        base();
        this.scene.traverse(o => { if (o.material?.transparent || o.isLine) o.visible = false; });
      };
      c.addPass(ao);
      c.addPass(new OutputPass());
      this.composer = c;
    } catch (err) {
      console.warn('Ohne Ambient Occlusion:', err);
      this.composer = false;
    }
  }

  initPicking() {
    const canvas = this.canvas;
    this.tip = document.createElement('div');
    this.tip.className = 'anat3d-tip';
    this.tip.hidden = true;
    this.pin = document.createElement('div');
    this.pin.className = 'anat3d-pin';
    this.pin.hidden = true;
    canvas.parentElement.append(this.tip, this.pin);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const pick = e => {
      if (!this.current) return null;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      // Haut überspringen, sonst trifft man immer nur sie
      return ray.intersectObject(this.current, true).find(h => h.object.visible && h.object.userData.key !== 'skin') || null;
    };
    let down = null;
    canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const hit = pick(e);
      this.select(hit ? hit.object.userData.key : null, hit?.point);
      this.tip.hidden = true;
    });
    canvas.addEventListener('pointermove', e => {
      const hit = e.buttons ? null : pick(e);
      this.tip.hidden = !hit || hit.object.userData.key === this.selected?.key;
      if (!hit) return;
      const r = canvas.getBoundingClientRect();
      this.tip.textContent = NAMES[hit.object.userData.key] || hit.object.userData.key;
      this.tip.style.left = `${e.clientX - r.left + 14}px`;
      this.tip.style.top = `${e.clientY - r.top + 10}px`;
    });
    canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; });
  }

  // Angeklicktes Organ hervorheben und dauerhaft beschriften
  select(key, point) {
    for (const root of Object.values(this.models)) {
      root.traverse(o => { if (o.material?.userData.highlight) o.material.userData.highlight.value.setRGB(0, 0, 0); });
    }
    this.selected = key && point ? { key, point: point.clone() } : null;
    this.pin.hidden = !this.selected;
    if (!this.selected) return;
    this.pin.textContent = NAMES[key] || key;
    this.current.traverse(o => { if (o.userData.key === key) o.material.userData.highlight?.value.setRGB(0.12, 0.1, 0.04); });
  }

  setLayer(id, on) {
    this.layers[id] = on;
    this.applyLayers();
  }

  applyLayers() {
    if (!this.current) return;
    const vis = {};
    for (const l of LAYERS) for (const k of l.keys) vis[k] = this.layers[l.id];
    this.current.traverse(o => { if (o.isMesh) o.visible = vis[o.userData.key] ?? true; });
    if (this.selected && !vis[this.selected.key]) this.select(null);
  }

  async load(name, url) {
    if (this.models[name]) return this.models[name];
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const root = (await loader.loadAsync(url)).scene;
    root.traverse(o => {
      if (!o.isMesh) return;
      const key = o.name.replace(/_\d+$/, '');
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      o.material = material(key);
      o.userData.key = key;
      if (key === 'skin') o.renderOrder = 10;
    });
    const box = new THREE.Box3().setFromObject(root);
    root.traverse(o => { if (o.userData.key === 'skin') o.material.userData.zRange.value.set(box.min.z, box.max.z); });
    this.models[name] = root;
    return root;
  }

  async show(name, url) {
    const root = await this.load(name, url);
    if (this.current === root) return;
    if (this.current) this.scene.remove(this.current);
    this.select(null);
    this.scene.add(root);
    this.current = root;
    this.applyLayers();
    const box = new THREE.Box3().setFromObject(root);
    this.center = box.getCenter(new THREE.Vector3());
    this.size = box.getSize(new THREE.Vector3());
    this.userMoved = false;
  }

  // o: Ursprung der Sonde (mm), M: Spalten L, D, E im RAS-System; us: Canvas des Ultraschallbilds
  update({ o, M, kind, depthCm, topCm, us, usAspect }) {
    if (!this.current) return;
    if (this.probeKind !== kind) {
      if (this.probe) this.scene.remove(this.probe);
      this.probe = probeMesh(kind);
      this.probe.matrixAutoUpdate = false;
      this.probeKind = kind;
      this.scene.add(this.probe);
      this.fanKey = null;
    }
    const L = new THREE.Vector3(M[0][0], M[1][0], M[2][0]);
    const D = new THREE.Vector3(M[0][1], M[1][1], M[2][1]);
    const E = new THREE.Vector3(M[0][2], M[1][2], M[2][2]);
    // Sondensystem: x = L, y = D (in den Körper), z = E
    const basis = new THREE.Matrix4().makeBasis(L, D, E).setPosition(o[0], o[1], o[2]);
    this.probe.matrix.copy(basis);

    if (!this.usTex) {
      this.usTex = new THREE.CanvasTexture(us);
      this.usTex.colorSpace = THREE.SRGBColorSpace;
    }
    const fk = `${kind}|${depthCm}|${topCm}|${usAspect.toFixed(3)}`;
    if (this.fanKey !== fk) {
      if (this.fan) { this.scene.remove(this.fan); this.fan.userData.dispose(); }
      this.fan = fanMesh(kind, depthCm * 10, topCm * 10, (depthCm + topCm) * 10 * usAspect, this.usTex);
      this.fan.matrixAutoUpdate = false;
      this.scene.add(this.fan);
      this.fanKey = fk;
    }
    this.fan.matrix.copy(basis);
    this.fan.visible = this.showFan;
    if (this.showFan) this.usTex.needsUpdate = true;
    if (!this.userMoved) this.frame(o, D, E);
  }

  // Kamera von vorn, so gedreht, dass man schräg auf die Schallebene schaut (Blick nahe ihrer Normalen E)
  frame(o, D, E) {
    const target = new THREE.Vector3(...o).addScaledVector(D, 60).lerp(this.center, 0.6);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = Math.max(this.size.z, this.size.x / this.camera.aspect) * 0.62 / Math.tan(fov / 2) + this.size.y / 2;
    const front = new THREE.Vector3(0, 1, 0.2);
    const n = E.clone().multiplyScalar(Math.sign(E.dot(front)) || 1);
    const dir = front.normalize().multiplyScalar(1.1).add(n).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
  }

  resetView() { this.userMoved = false; }

  render(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.composer) this.composer.setSize(w, h);
      else if (this.composer === null) this.initComposer(w, h);
    }
    this.controls.update();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    if (this.selected) {
      const p = this.selected.point.clone().project(this.camera);
      const dpr = window.devicePixelRatio || 1;
      this.pin.style.left = `${((p.x + 1) / 2) * (w / dpr)}px`;
      this.pin.style.top = `${((1 - p.y) / 2) * (h / dpr)}px`;
    }
  }
}
