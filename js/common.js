// Gemeinsame Daten und Rotationsmathematik für Monitor und Schallkopf.

export const PROBES = {
  linear: { id: 0, name: 'Linear', mhz: 7.5, min: 2, max: 8, def: 5 },
  convex: { id: 1, name: 'Konvex', mhz: 3.5, min: 6, max: 24, def: 16 },
  phased: { id: 2, name: 'Sektor', mhz: 2.5, min: 6, max: 24, def: 16 },
};

// vol/key verweisen auf data/<vol>/meta.json -> windows[key]
// hold: Halte-Hinweis beim Fensterwechsel (Ort, Schallrichtung, Marker), passend zu den Achsen in meta.json
export const WINDOWS = [
  // marker: Handykante, an der der grüne Marker angezeigt wird.
  // dreh: Vorzeichen je Drehachse der Sonde [Fächern um L, Drehen um D, Kippen in der Bildebene um E] gegenüber dem Handy.
  // wisch: Vorzeichen beim Wischen/Maus-Schieben. Alles nach Simons Tests am Handy (27.10.2026), anpassbar unter „Justage“.
  // hint: Schallkopf, mit dem das Fenster startet; tiefe: Starttiefe in cm (sonst die des Schallkopfs).
  { name: 'RUQ (Morison)', hint: 'convex', vol: 'abdomen', key: 'ruq', marker: 'links', dreh: [1, -1, 1], wisch: -1,
    hold: ['Rechte Flanke, mittlere Axillarlinie, Höhe Rippenbogen', 'Schall quer in den Körper (nach medial)', 'Marker zum Kopf'] },
  { name: 'LUQ (splenorenal)', hint: 'convex', vol: 'abdomen', key: 'luq', marker: 'rechts', dreh: [-1, -1, -1], wisch: 1,
    hold: ['Linke Flanke, hintere Axillarlinie, etwas höher als rechts', 'Schall quer in den Körper (nach medial)', 'Marker zum Kopf (am Handy die rechte Kante)'] },
  { name: 'Subxiphoidal', hint: 'phased', vol: 'thorax', key: 'subxiphoid', tiefe: 19, marker: 'links', dreh: [1, -1, 1], wisch: -1,
    hold: ['Direkt unter dem Schwertfortsatz', 'Schall nach hinten, leicht Richtung Kopf', 'Marker zur rechten Patientenseite'] },
  { name: 'Becken (suprapubisch)', hint: 'convex', vol: 'abdomen', key: 'pelvis', marker: 'links', dreh: [1, -1, 1], wisch: -1,
    hold: ['Knapp über dem Schambein, quer', 'Schall nach hinten, leicht Richtung Füße', 'Marker zur rechten Patientenseite'] },
  { name: 'Lunge rechts', hint: 'linear', vol: 'thorax', key: 'lung_r', tiefe: 8, marker: 'rechts', dreh: [-1, -1, -1], wisch: 1,
    hold: ['Rechts vorn, Zwischenrippenraum knapp lateral der Medioklavikularlinie (zwei Rippen im Bild)', 'Schall senkrecht nach hinten', 'Marker zum Kopf (am Handy die rechte Kante)'] },
  { name: 'Lunge links', hint: 'linear', vol: 'thorax', key: 'lung_l', tiefe: 8, marker: 'rechts', dreh: [-1, -1, -1], wisch: 1,
    hold: ['Links vorn, Zwischenrippenraum knapp lateral der Medioklavikularlinie (zwei Rippen im Bild)', 'Schall senkrecht nach hinten', 'Marker zum Kopf (am Handy die rechte Kante)'] },
];

// Justage am Rechner (localStorage 'pocus-justage2' = { <key>: { marker, um: { faechern, drehen, kippen, wischen } } }):
// Markerseite und Umkehrungen gegenüber den Werten aus WINDOWS
export const ACHSEN = ['faechern', 'drehen', 'kippen'];
let justage = {};
try { justage = JSON.parse(localStorage.getItem('pocus-justage2') || '{}') || {}; } catch { /* Standardwerte */ }
export function winCfg(i) {
  const w = WINDOWS[i] || WINDOWS[0], j = justage[w.key] || {}, um = j.um || {};
  return {
    marker: j.marker === 'rechts' || j.marker === 'links' ? j.marker : w.marker,
    dreh: w.dreh.map((v, k) => um[ACHSEN[k]] ? -v : v),
    wisch: um.wischen ? -w.wisch : w.wisch,
    um,
  };
}
export function setJustage(i, patch) {
  const w = WINDOWS[i], j = { marker: winCfg(i).marker, um: { ...(justage[w.key]?.um || {}) } };
  if (patch.marker) j.marker = patch.marker;
  if (patch.um) Object.assign(j.um, patch.um);
  for (const k in j.um) if (!j.um[k]) delete j.um[k];
  if (j.marker === w.marker && !Object.keys(j.um).length) delete justage[w.key]; else justage[w.key] = j;
  try { localStorage.setItem('pocus-justage2', JSON.stringify(justage)); } catch { /* gilt dann nur bis zum Neuladen */ }
}

// Bit pro Befund, passt zu uCase im Shader
export const FINDINGS = [
  { bit: 1, name: 'Freie Flüssigkeit Morison', win: 0 },
  { bit: 2, name: 'Freie Flüssigkeit LUQ', win: 1 },
  { bit: 4, name: 'Perikarderguss', win: 2 },
  { bit: 8, name: 'Freie Flüssigkeit Becken', win: 3 },
  { bit: 16, name: 'Pneumothorax rechts', win: 4 },
  { bit: 32, name: 'Pneumothorax links', win: 5 },
];

// id taucht in NFC-Tag-Adressen auf (probe.html?s=<id>)
export const SCENARIOS = [
  { id: 'normal', name: 'Normalbefund', cases: 0 },
  { id: 'haemo', name: 'Hämoperitoneum', cases: 1 | 2 | 8 },
  { id: 'tamponade', name: 'Perikardtamponade', cases: 4 },
  { id: 'ptx', name: 'Pneumothorax rechts', cases: 16 },
];

// Gewebeklassen wie in tools/build_volume.py, mit Farbe für Anatomieansicht und Einfärbung.
// tint: wird im Ultraschallbild eingefärbt (Bauchwand und Fett bleiben grau)
// scat: Rückstreuung (Amplitude, Leber = 1), abgeglichen an echten Konvex-Aufnahmen: Nierenrinde etwas
//   echoärmer als Leber, Milz etwas echoreicher, Sinus hell, Blut und Flüssigkeit echofrei.
//   Fett steht hier mit 1, den Faktor (Unterhaut dunkel, Bauchhöhle hell) setzt der Shader.
// z: akustische Impedanz in MRayl (Literaturwerte), Sprünge ergeben die hellen Grenzflächen.
//   Knochen und Gas zeichnet der Shader selbst, deshalb hier neutral.
// hu: typischer CT-Wert der Klasse; Abweichungen davon werden zu feiner Binnenstruktur.
// Speckle-Charakter je Gewebe: cell = Körnchengröße relativ zur Sonde, spk = Speckle-Kontrast (1 = voll entwickelt),
//   lay = Schichtung parallel zur Sondenfläche (Muskelfasern, strähniges Myokard, Darmwand). Fehlt ein Wert, gilt 1, 1, 0.
export const TISSUES = [
  { name: 'Luft', rgb: [0, 0, 0], scat: 0, z: 1.63, hu: -1000 },
  { name: 'Lunge / Darmgas', rgb: [0.55, 0.75, 0.95], scat: 0, z: 1.63, hu: -850 },
  { name: 'Fett', rgb: [0.95, 0.85, 0.45], scat: 1, z: 1.38, hu: -95, cell: 1.1, spk: 0.9 },
  { name: 'Weichteil', rgb: [0.62, 0.58, 0.56], scat: 0.8, z: 1.63, hu: 10, lay: 0.2 },
  { name: 'Leber', rgb: [0.70, 0.30, 0.18], tint: true, scat: 1.0, z: 1.66, hu: 44, cell: 1.0, spk: 1.0, lay: 0.05 },
  { name: 'Milz', rgb: [0.60, 0.25, 0.60], tint: true, scat: 1.1, z: 1.65, hu: 36, cell: 0.85, spk: 0.85 },
  { name: 'Niere', rgb: [0.95, 0.55, 0.15], tint: true, scat: 0.62, z: 1.62, hu: 20, cell: 0.9, spk: 0.85, lay: 0.15 },
  { name: 'Nierenbecken', rgb: [1.0, 0.85, 0.40], tint: true, scat: 2.0, z: 1.45, hu: 0, cell: 1.2, lay: 0.3 },
  { name: 'Gefäß', rgb: [0.90, 0.10, 0.12], tint: true, scat: 0.035, z: 1.61, hu: 32 },
  { name: 'Herzmuskel', rgb: [0.85, 0.35, 0.45], tint: true, scat: 0.7, z: 1.67, hu: 32, cell: 0.9, spk: 0.9, lay: 0.35 },
  { name: 'Knochen', rgb: [0.95, 0.93, 0.85], scat: 0.3, z: 1.63, hu: 200 },
  { name: 'Darm', rgb: [0.45, 0.70, 0.30], tint: true, scat: 1.25, z: 1.63, hu: 10, cell: 1.2, lay: 0.3 },
  { name: 'Flüssigkeit', rgb: [0.15, 0.55, 1.0], tint: true, scat: 0.02, z: 1.52, hu: 10 },
  { name: 'Haut', rgb: [1.0, 0.75, 0.65], scat: 1.6, z: 1.75, hu: -150, cell: 0.7, lay: 0.3 },
  { name: 'Muskel', rgb: [0.70, 0.22, 0.22], scat: 0.55, z: 1.70, hu: 20, cell: 0.9, lay: 0.5 },
  { name: 'Knorpel', rgb: [0.45, 0.90, 0.90], scat: 0.08, z: 1.85, hu: 90 },
];

// Unterklassen aus Kanal A (Bits 4-7), siehe SUB in tools/build_volume.py.
// Herzhöhlen sind aus der Herzkontur abgeleitet, im nativen CT nicht sichtbar.
export const SUBLABELS = ['', 'Aorta', 'V. cava inferior', 'Pfortader / V. lienalis', 'V. cava superior', 'Lungenvenen',
  'A. iliaca', 'V. iliaca', 'Linker Ventrikel', 'Rechter Ventrikel', 'Linker Vorhof', 'Rechter Vorhof',
  'Harnblase', 'Gallenblase', 'Supraaortale Arterien', 'V. brachiocephalica'];

const D2R = Math.PI / 180;

export function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qAxis(x, y, z, ang) {
  const s = Math.sin(ang / 2);
  return [x * s, y * s, z * s, Math.cos(ang / 2)];
}

// DeviceOrientation (alpha, beta, gamma) nach W3C: R = Rz(alpha) * Rx(beta) * Ry(gamma)
export function quatFromEuler(a, b, g) {
  return qMul(qMul(qAxis(0, 0, 1, a * D2R), qAxis(1, 0, 0, b * D2R)), qAxis(0, 1, 0, g * D2R));
}

export function qNlerp(a, b, t) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (s * b[i] - v) * t);
  const n = Math.hypot(...q);
  return q.map(v => v / n);
}

// Zeilenweise 3x3-Matrix
export function matFromQuat([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export function matMul(A, B) {
  return A.map(r => [0, 1, 2].map(c => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
}

export function matT(A) {
  return [0, 1, 2].map(r => [A[0][r], A[1][r], A[2][r]]);
}

export function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
export function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
export function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }

// Handy kopfüber, Oberkante = Schallkopffläche, linke Handykante = Marker (links im Bild).
// Geräteachsen: x = lateral, +y = Tiefe, -z = Elevation. Szene: y zeigt in die Tiefe.
// Aus der Kalibrierlage Rn und der aktuellen Lage Rc wird die Sondenlage in der Szene.
// dreh: Vorzeichen je Drehachse (Sondensystem L, D, E). Die relative Drehung wird als Quaternion genommen und ihr
// Vektoranteil achsweise umgekehrt; so lässt sich jede Achse einzeln umdrehen, bei den Lagen aus WINDOWS genügt das.
export function quatFromMat(m) {
  const t = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (t > 0) { const s = 2 * Math.sqrt(t + 1); w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]); w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]); w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s; }
  else { const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]); w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4; }
  return [x, y, z, w];
}
export function probeMatrix(Rn, Rc, dreh = [-1, -1, 1]) {
  const [x, y, z, w] = quatFromMat(matMul(matT(Rn), Rc));
  return matFromQuat([dreh[0] * x, dreh[1] * y, dreh[2] * z, w]);
}
