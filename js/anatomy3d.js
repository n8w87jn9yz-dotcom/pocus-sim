// 3D-Anatomieansicht: Oberflächenmodelle aus demselben CT wie das Ultraschallbild, Sonde und Schallebene.
// Koordinaten wie im Volumen: mm, RAS (x = rechts, y = anterior, z = kranial).
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';

// Farben angelehnt an anatomische Atlanten
const LOOK = {
  skin: { color: 0xe2b49a, skin: true },
  bone: { color: 0xeae2cf, roughness: 0.55 },
  cartilage: { color: 0xc9d6d4, roughness: 0.4, clearcoat: 0.3, opacity: 0.8 },
  lung: { color: 0xe6a5a3, roughness: 0.6, opacity: 0.45 },
  liver: { color: 0x8c2a22, roughness: 0.35, clearcoat: 0.6 },
  spleen: { color: 0x6f2436, roughness: 0.35, clearcoat: 0.6 },
  kidney: { color: 0xa0412f, roughness: 0.35, clearcoat: 0.6 },
  heart: { color: 0xb23a30, roughness: 0.4, clearcoat: 0.5 },
  bowel: { color: 0xc4806b, roughness: 0.45, clearcoat: 0.4 },
  fluid: { color: 0xd8c46a, roughness: 0.25, clearcoat: 0.8, opacity: 0.85 },
  artery: { color: 0xc8161d, roughness: 0.3, clearcoat: 0.7 },
  vein: { color: 0x2f56b0, roughness: 0.3, clearcoat: 0.7 },
};

function material(key) {
  const l = LOOK[key] || { color: 0x999999 };
  if (l.skin) {
    // Haut als Glashülle: in der Mitte fast durchsichtig, zum Rand hin deckend (Fresnel)
    const m = new THREE.MeshPhysicalMaterial({
      color: l.color, roughness: 0.6, transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    m.onBeforeCompile = s => {
      s.fragmentShader = s.fragmentShader.replace('#include <opaque_fragment>', `
        float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
        diffuseColor.a = mix(0.07, 0.55, pow(rim, 2.2));
        #include <opaque_fragment>`);
    };
    return m;
  }
  return new THREE.MeshPhysicalMaterial({
    color: l.color, roughness: l.roughness ?? 0.5, metalness: 0, clearcoat: l.clearcoat ?? 0,
    clearcoatRoughness: 0.35, sheen: 0.3, sheenColor: new THREE.Color(0xffffff),
    transparent: l.opacity !== undefined, opacity: l.opacity ?? 1, depthWrite: l.opacity === undefined,
  });
}

// Konvex-, Linear- und Sektorschallkopf: Griff entlang -D, Lauffläche entlang L, Marker auf -L-Seite
const FOOT = { linear: [40, 10], convex: [62, 18], phased: [22, 16] };
function probeMesh(kind) {
  const g = new THREE.Group();
  const [w, t] = FOOT[kind];
  const shell = new THREE.MeshPhysicalMaterial({ color: 0xf2f4f7, roughness: 0.3, clearcoat: 1 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x2a3038, roughness: 0.5 });
  const head = new THREE.Mesh(new THREE.BoxGeometry(w, 22, t, 1, 1, 1), shell);
  head.position.y = -11;
  const lens = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 3, t * 0.8), dark);
  lens.position.y = -1;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(t * 0.55, Math.min(w, t) * 0.7, 80, 24), shell);
  grip.position.y = -60;
  grip.scale.z = 0.8;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 120, 12), dark);
  cable.position.y = -160;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0x4fb3ff }));
  marker.position.set(-w / 2 + 4, -14, t / 2 + 0.5);   // Marker auf der Seite, die im Bild links liegt
  g.add(head, lens, grip, cable, marker);
  return g;
}

// Schallfächer in der Ebene L (x) / D (y) des Sondensystems, in mm, Textur = Ultraschallbild
function fanGeometry(kind, depthMm, topMm) {
  const shape = new THREE.Shape();
  if (kind === 'linear') {
    shape.moveTo(-20, 0); shape.lineTo(20, 0); shape.lineTo(20, depthMm); shape.lineTo(-20, depthMm); shape.closePath();
  } else {
    const [r0, a] = kind === 'convex' ? [40, 0.62] : [0, 0.78];
    const c = kind === 'convex' ? -40 : 0;
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const t = -a + (2 * a * i) / 32;
      pts.push([Math.sin(t) * (r0 + depthMm), c + Math.cos(t) * (r0 + depthMm)]);
    }
    if (r0) for (let i = 32; i >= 0; i--) { const t = -a + (2 * a * i) / 32; pts.push([Math.sin(t) * r0, c + Math.cos(t) * r0]); }
    else pts.push([0, 0]);
    shape.moveTo(...pts[0]);
    for (const p of pts.slice(1)) shape.lineTo(...p);
  }
  const g = new THREE.ShapeGeometry(shape, 48);
  // UV wie das Ultraschallbild: v = 1 oben (Tiefe -topMm), u über die Breite des Canvas
  const pos = g.attributes.position, uv = g.attributes.uv;
  return { g, mapUV: (wMm) => {
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, 0.5 + pos.getX(i) / wMm, 1 - (pos.getY(i) + topMm) / (depthMm + topMm));
    }
    uv.needsUpdate = true;
  } };
}

const NAMES = {
  skin: 'Haut', bone: 'Knochen', cartilage: 'Rippenknorpel', lung: 'Lunge', liver: 'Leber', spleen: 'Milz',
  kidney: 'Niere', heart: 'Herz', bowel: 'Magen und Darm', fluid: 'Harnblase / Gallenblase',
  artery: 'Aorta und Arterien', vein: 'V. cava und Venen',
};

export class Anatomy3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.4, 1, 0.8);
    const back = new THREE.DirectionalLight(0x9fc4ff, 0.8);
    back.position.set(0.5, -1, 0.3);
    this.scene.add(key, back, new THREE.HemisphereLight(0xffffff, 0x404858, 0.4));
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
    this.tip = document.createElement('div');
    this.tip.className = 'anat3d-tip';
    this.tip.hidden = true;
    canvas.parentElement.append(this.tip);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    canvas.addEventListener('pointermove', e => {
      if (!this.current || e.buttons) { this.tip.hidden = true; return; }
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      // Haut überspringen, sonst trifft man immer nur sie
      const hit = ray.intersectObject(this.current, true).find(h => h.object.userData.key !== 'skin');
      this.tip.hidden = !hit;
      if (hit) {
        this.tip.textContent = NAMES[hit.object.userData.key] || hit.object.userData.key;
        this.tip.style.left = `${e.clientX - r.left + 14}px`;
        this.tip.style.top = `${e.clientY - r.top + 10}px`;
      }
    });
    canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; });
  }

  async load(name, url) {
    if (this.models[name]) return this.models[name];
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene;
    root.traverse(o => {
      if (!o.isMesh) return;
      const key = o.name.replace(/_\d+$/, '');
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      o.material = material(key);
      o.userData.key = key;
      if (key === 'skin') o.renderOrder = 10;
    });
    this.models[name] = root;
    return root;
  }

  async show(name, url) {
    const root = await this.load(name, url);
    if (this.current === root) return;
    if (this.current) this.scene.remove(this.current);
    this.scene.add(root);
    this.current = root;
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
      this.probeKind = kind;
      this.scene.add(this.probe);
      this.fanKey = null;
    }
    const L = new THREE.Vector3(M[0][0], M[1][0], M[2][0]);
    const D = new THREE.Vector3(M[0][1], M[1][1], M[2][1]);
    const E = new THREE.Vector3(M[0][2], M[1][2], M[2][2]);
    // Sondensystem: x = L, y = D (in den Körper), z = E
    const basis = new THREE.Matrix4().makeBasis(L, D, E).setPosition(o[0], o[1], o[2]);
    this.probe.matrixAutoUpdate = false;
    this.probe.matrix.copy(basis);

    const fk = `${kind}|${depthCm}|${topCm}`;
    if (this.fanKey !== fk) {
      if (this.fan) { this.scene.remove(this.fan); this.fan.geometry.dispose(); }
      const { g, mapUV } = fanGeometry(kind, depthCm * 10, topCm * 10);
      mapUV((depthCm + topCm) * 10 * usAspect);
      if (!this.usTex) {
        this.usTex = new THREE.CanvasTexture(us);
        this.usTex.colorSpace = THREE.SRGBColorSpace;
      }
      this.fan = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        map: this.usTex, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false,
      }));
      this.fan.renderOrder = 20;
      this.fan.matrixAutoUpdate = false;
      this.scene.add(this.fan);
      this.fanKey = fk;
    }
    this.fan.matrix.copy(basis);
    this.fan.visible = this.showFan;
    if (this.showFan) this.usTex.needsUpdate = true;
    if (!this.userMoved) this.frame(o, D, E);
  }

  // Kamera von schräg vorn auf die Sonde, Körper bleibt im Bild
  frame(o, D, E) {
    const target = new THREE.Vector3(...o).addScaledVector(D, 60).lerp(this.center, 0.6);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = Math.max(this.size.z, this.size.x / this.camera.aspect) * 0.62 / Math.tan(fov / 2) + this.size.y / 2;
    // von vorn, aber so gedreht, dass man schräg auf die Schallebene schaut (Blickrichtung nahe ihrer Normalen E)
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
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
