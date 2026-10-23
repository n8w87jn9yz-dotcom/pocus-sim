// Kamera-Tracking am Handy: erkennt ArUco-Marker (ARUCO_MIP_36h12) auf ausgedruckten A4-Blättern
// und liefert die Verschiebung der Sondenspitze seit dem Ansetzen, im Sondenkoordinatensystem.
// Braucht die klassischen Skripte vendor/js-aruco2/{cv,aruco,svd,posit1}.js (globale AR und POS).

export const MARKER_MM = 152;        // Kantenlänge des schwarzen Quadrats beim Druck mit 100 %
const TIP_MM = 140;                  // Abstand Kamera -> Unterkante des Handys
const PROC_W = 480;                  // Breite des Analysebilds

const transpose = A => [0, 1, 2].map(r => [A[0][r], A[1][r], A[2][r]]);
const mulMV = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const sub = (a, b) => a.map((v, i) => v - b[i]);

// Die Drehung aus POSIT ist bei fast frontaler Sicht mehrdeutig, die Lage der Markermitte nicht.
// Deshalb nur die Markermitte aus dem Bild nehmen und die Drehung vom Gyro (R: Gerät -> Erde).
// POSIT rechnet mit z nach vorn, das Gerätesystem mit z zum Untersucher.
export function markerInDevice(t) {
  return [t[0], t[1], -t[2]];
}

// Spitze der Sonde (Unterkante des Handys) relativ zur Markermitte, im Erdsystem
export function tipOf(R, mDev) {
  return mulMV(R, sub([0, -TIP_MM, 0], mDev));
}

export class Tracker {
  constructor(video, preview, onUpdate) {
    this.video = video;
    this.preview = preview;
    this.onUpdate = onUpdate;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
    this.anchors = {};               // Marker-ID -> Spitze relativ zum Marker beim Ansetzen (Erdsystem)
    this.R = null;                   // aktuelle Lage Gerät -> Erde vom Gyro
    this.R0 = null;                  // Lage beim Ansetzen
    this.pendingAnchor = false;
    this.last = null;                // geglättete Verschiebung in mm (lateral, Tiefe, Elevation)
    this.running = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.video.srcObject?.getTracks().forEach(t => t.stop());
  }

  setOrientation(R) {
    this.R = R;
  }

  // Beim nächsten Bild die aktuelle Lage als Startpunkt übernehmen
  anchor() {
    this.pendingAnchor = true;
  }

  loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.videoWidth) this.process(v);
    requestAnimationFrame(() => this.loop());
  }

  process(v) {
    const w = PROC_W, h = Math.round(PROC_W * v.videoHeight / v.videoWidth);
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const markers = this.detector.detect(img);
    // Horizontales Bildfeld der Hauptkamera: ca. 50° im Hochformat, ca. 63° im Querformat
    const hfov = (w < h ? 50 : 63) * Math.PI / 180;
    const f = (w / 2) / Math.tan(hfov / 2);
    this.drawPreview(markers, w, h);
    if (!this.R) { this.onUpdate({ ok: false, visible: markers.length, anchored: false, noGyro: true }); return; }
    const tips = {};
    for (const m of markers) {
      const pts = m.corners.map(c => ({ x: c.x - w / 2, y: h / 2 - c.y }));
      const p = new POS.Posit(MARKER_MM, f).pose(pts);
      tips[m.id] = tipOf(this.R, markerInDevice(p.bestTranslation));
    }

    const ids = Object.keys(tips);
    if (this.pendingAnchor && ids.length) {
      this.anchors = {};
      for (const id of ids) this.anchors[id] = tips[id];
      this.R0 = this.R;
      this.pendingAnchor = false;
      this.last = [0, 0, 0];
    }

    // Verschiebung über einen bereits verankerten Marker bestimmen
    const known = ids.find(id => this.anchors[id]);
    if (!known) {
      this.onUpdate({ ok: false, visible: ids.length, anchored: Object.keys(this.anchors).length > 0 });
      return;
    }
    const dW = sub(tips[known], this.anchors[known]);
    // Neue Marker nachträglich verankern, damit beim Wechsel des Blatts nichts springt
    for (const id of ids) if (!this.anchors[id]) this.anchors[id] = sub(tips[id], dW);
    // Verschiebung im Gerätesystem der Ansetzlage
    const dDev = mulMV(transpose(this.R0), dW);
    // Gerät -> Sonde: lateral = x, Tiefe = -y, Elevation = z
    const d = [dDev[0], -dDev[1], dDev[2]];
    this.last = this.last ? this.last.map((v, i) => v + (d[i] - v) * 0.4) : d;
    this.onUpdate({ ok: true, d: this.last, id: +known, visible: ids.length, anchored: true });
  }

  drawPreview(markers, w, h) {
    const c = this.preview;
    if (!c) return;
    if (c.width !== w) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    ctx.lineWidth = 4;
    for (const m of markers) {
      ctx.strokeStyle = this.anchors[m.id] ? '#4fd18b' : '#e7b85a';
      ctx.beginPath();
      m.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = 'bold 22px system-ui';
      ctx.fillText(`Blatt ${m.id}`, m.corners[0].x, m.corners[0].y - 8);
    }
  }
}
