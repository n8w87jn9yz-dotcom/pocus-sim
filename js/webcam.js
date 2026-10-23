// Kamera-Tracking am Rechner: die Laptop-Webcam steht still und erkennt einen kleinen ArUco-Marker
// (ARUCO_MIP_36h12, ID 1), der hinten unten auf dem Handy klebt. Daraus und aus der Lage vom Gyro
// ergibt sich, wie weit die Sondenspitze seit dem Kalibrieren verschoben wurde.
// Braucht die klassischen Skripte vendor/js-aruco2/{cv,aruco,svd,posit1}.js (globale AR und POS).

export const PHONE_MARKER_MM = 54;   // Kantenlänge des schwarzen Quadrats, siehe print.html
export const PHONE_MARKER_ID = 1;
const LEVER = [0, -34, 4];           // Markermitte -> Mitte der Unterkante, im Gerätesystem (mm)
const HFOV = 60;                     // horizontales Bildfeld einer üblichen Laptop-Webcam (Grad)
const PROC_W = 960;                  // Breite des Analysebilds

const T = A => [0, 1, 2].map(r => [A[0][r], A[1][r], A[2][r]]);
const mul = (A, B) => A.map(r => [0, 1, 2].map(c => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
const mulV = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
// POSIT rechnet linkshändig (z nach vorn), hier wird rechtshändig mit z zur Kamera hin gerechnet
const S = m => m.map((r, i) => r.map((v, j) => v * (i === 2 ? -1 : 1) * (j === 2 ? -1 : 1)));
// Marker (x rechts, y oben, z aus dem Papier) im Gerätesystem: klebt auf der Rückseite, Schrift aufrecht
const R_DM = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];

function orthonormalize(M) {
  const c0 = [M[0][0], M[1][0], M[2][0]], c1 = [M[0][1], M[1][1], M[2][1]];
  const n = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const x = n(c0);
  const d = x[0] * c1[0] + x[1] * c1[1] + x[2] * c1[2];
  const y = n(c1.map((v, i) => v - d * x[i]));
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [0, 1, 2].map(r => [x[r], y[r], z[r]]);
}
const similarity = (A, B) => A.reduce((s, r, i) => s + r[0] * B[i][0] + r[1] * B[i][1] + r[2] * B[i][2], 0);

// Markerecken (Bildpunkte, Ursprung Bildmitte, y nach oben) -> Markermitte und mögliche Drehungen der Kamera
export function markerPose(pts, f) {
  const p = new POS.Posit(PHONE_MARKER_MM, f).pose(pts);
  const t = p.bestTranslation;
  return { t: [t[0], t[1], -t[2]], rots: [S(p.bestRotation), S(p.alternativeRotation)] };
}

export class WebcamTracker {
  constructor(video, preview, getOrientation, onUpdate) {
    this.video = video;
    this.preview = preview;
    this.getOrientation = getOrientation;   // Lage Gerät -> Erde vom Gyro oder null
    this.onUpdate = onUpdate;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
    this.Rec = null;        // Lage der Webcam im Erdsystem, wird über viele Bilder gemittelt
    this.anchorT = null;    // Markermitte in der Kamera beim Kalibrieren
    this.R0 = null;
    this.pendingAnchor = false;
    this.last = null;
    this.lastProc = 0;
    this.running = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    await this.video.play();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.video.srcObject?.getTracks().forEach(t => t.stop());
  }

  anchor() { this.pendingAnchor = true; }

  // Neues Fenster: alte Verschiebung verwerfen, bis wieder kalibriert wird
  reset() { this.anchorT = null; this.last = null; this.pendingAnchor = false; }

  loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.videoWidth && now - this.lastProc > 33) {
      this.lastProc = now;
      this.process(this.video);
    }
    requestAnimationFrame(() => this.loop());
  }

  process(v) {
    const w = Math.min(PROC_W, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(v, 0, 0, w, h);
    const markers = this.detector.detect(this.ctx.getImageData(0, 0, w, h));
    const m = markers.find(k => k.id === PHONE_MARKER_ID) || markers[0];
    this.drawPreview(m, w, h);
    const R = this.getOrientation();
    if (!m) return this.onUpdate({ ok: false, seen: false, anchored: !!this.anchorT });
    if (!R) return this.onUpdate({ ok: false, seen: true, noGyro: true });

    const f = (w / 2) / Math.tan(HFOV * Math.PI / 360);
    const { t, rots } = markerPose(m.corners.map(c => ({ x: c.x - w / 2, y: h / 2 - c.y })), f);
    // Lage der Webcam = Gyro-Lage des Handys * Marker im Handy * Marker in der Kamera (transponiert).
    // POSIT liefert bei frontaler Sicht zwei Lösungen; genommen wird die, die zur bisherigen Schätzung passt.
    const cands = rots.map(Rcm => mul(mul(R, R_DM), T(Rcm)));
    const inst = this.Rec ? cands.reduce((a, b) => (similarity(b, this.Rec) > similarity(a, this.Rec) ? b : a)) : cands[0];
    if (!this.Rec) this.Rec = inst;
    else if (similarity(inst, this.Rec) > 2.6) this.Rec = orthonormalize(this.Rec.map((r, i) => r.map((x, j) => x + (inst[i][j] - x) * 0.05)));

    if (this.pendingAnchor) {
      this.anchorT = t;
      this.R0 = R;
      this.pendingAnchor = false;
      this.last = [0, 0, 0];
    }
    if (!this.anchorT) return this.onUpdate({ ok: false, seen: true, anchored: false });
    // Nur die Differenz wird gedreht, so wirkt ein kleiner Fehler der Webcam-Lage kaum.
    // Hebel: kippt das Handy um die Spitze, wandert der Marker, die Spitze aber nicht.
    const dW = add(mulV(this.Rec, sub(t, this.anchorT)), sub(mulV(R, LEVER), mulV(this.R0, LEVER)));
    // Verschiebung im Gerätesystem der Kalibrierlage, dann Gerät -> Sonde (lateral, Tiefe, Elevation)
    const dDev = mulV(T(this.R0), dW);
    const d = [dDev[0], -dDev[1], dDev[2]];
    this.last = this.last ? this.last.map((x, i) => x + (d[i] - x) * 0.4) : d;
    this.onUpdate({ ok: true, seen: true, anchored: true, d: this.last, dist: Math.round(-t[2] / 10) });
  }

  drawPreview(m, w, h) {
    const c = this.preview;
    if (!c) return;
    if (c.width !== w) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    if (!m) return;
    ctx.lineWidth = 6;
    ctx.strokeStyle = this.anchorT ? '#4fd18b' : '#e7b85a';
    ctx.beginPath();
    m.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
}
