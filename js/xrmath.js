// Rechenteil der Quest-Version (xr.html): Sondenspitze einmessen, Puppe auf den CT-Körper abbilden.
// Matrizen zeilenweise 3x3 wie in common.js, Vektoren als Arrays.
import { matMul, matT, quatFromMat, matFromQuat } from './common.js';

export const add = (a, b, k = 1) => a.map((v, i) => v + b[i] * k);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = a => { const l = len(a) || 1; return a.map(v => v / l); };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const mulV = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export const cols = (a, b, c) => [0, 1, 2].map(r => [a[r], b[r], c[r]]);
export const col = (M, c) => [M[0][c], M[1][c], M[2][c]];

// Lineares Gleichungssystem (Gauß mit Pivotsuche), A n x n zeilenweise
export function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Kleinste Quadrate über Normalgleichungen: Zeilen rows (je n Werte), rechte Seite rhs
export function lstsq(rows, rhs) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      b[i] += r[i] * rhs[k];
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j];
    }
  });
  return solve(A, b);
}

export function det3(M) {
  return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
}

export function inv3(M) {
  const d = det3(M);
  const c = (r0, c0, r1, c1) => M[r0][c0] * M[r1][c1] - M[r0][c1] * M[r1][c0];
  return [
    [c(1, 1, 2, 2), -c(0, 1, 2, 2), c(0, 1, 1, 2)],
    [-c(1, 0, 2, 2), c(0, 0, 2, 2), -c(0, 0, 1, 2)],
    [c(1, 0, 2, 1), -c(0, 0, 2, 1), c(0, 0, 1, 1)],
  ].map(r => r.map(v => v / d));
}

// Drehanteil einer Matrix (Polarzerlegung, Newton-Iteration R = (R + R^-T) / 2)
export function polarRotation(A) {
  const s = Math.cbrt(Math.abs(det3(A))) || 1;
  let R = A.map(r => r.map(v => v / s));
  for (let i = 0; i < 30; i++) {
    const Ri = matT(inv3(R));
    R = R.map((r, a) => r.map((v, b) => (v + Ri[a][b]) / 2));
  }
  return R;
}

// Winkel (rad) zwischen zwei Drehmatrizen
export function rotAngle(A, B) {
  const R = matMul(matT(A), B), t = (R[0][0] + R[1][1] + R[2][2] - 1) / 2;
  return Math.acos(Math.max(-1, Math.min(1, t)));
}

// Mittelwert mehrerer Drehungen über Quaternionen (für kleine Streuung ausreichend)
export function meanRotation(Rs) {
  const q0 = quatFromMat(Rs[0]), q = [0, 0, 0, 0];
  for (const R of Rs) {
    const p = quatFromMat(R), s = p[0] * q0[0] + p[1] * q0[1] + p[2] * q0[2] + p[3] * q0[3] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) q[i] += s * p[i];
  }
  const n = Math.hypot(...q);
  return matFromQuat(q.map(v => v / n));
}

// Pivot-Kalibrierung: Die Sondenspitze ruht auf einem festen Punkt c, der Controller wird darum gekreist.
// Für jede Lage (R Controllerdrehung, p Controllerposition) gilt R t + p = c. Gesucht: t (Spitze im
// Controllersystem) und c. Rückgabe mit mittlerem Restfehler und dem größten Kreiswinkel.
export function pivotCalibrate(samples) {
  const rows = [], rhs = [];
  for (const { R, p } of samples) {
    for (let k = 0; k < 3; k++) {
      rows.push([R[k][0], R[k][1], R[k][2], k === 0 ? -1 : 0, k === 1 ? -1 : 0, k === 2 ? -1 : 0]);
      rhs.push(-p[k]);
    }
  }
  const x = lstsq(rows, rhs);
  if (!x) return null;
  const t = x.slice(0, 3), c = x.slice(3);
  const res = samples.map(({ R, p }) => len(sub(add(mulV(R, t), p), c)));
  let spread = 0;
  for (const s of samples) spread = Math.max(spread, rotAngle(samples[0].R, s.R));
  return { t, c, rms: Math.sqrt(res.reduce((a, v) => a + v * v, 0) / res.length), spread };
}

// Affine Abbildung dst = A src + b aus Punktpaaren (mind. 4, nicht in einer Ebene).
// Rückgabe mit Restfehler je Punkt (in Einheiten von dst).
export function fitAffine(src, dst) {
  const rows = src.map(p => [p[0], p[1], p[2], 1]);
  const A = [], b = [];
  for (let k = 0; k < 3; k++) {
    const x = lstsq(rows, dst.map(q => q[k]));
    if (!x) return null;
    A.push(x.slice(0, 3));
    b.push(x[3]);
  }
  const res = src.map((p, i) => len(sub(add(mulV(A, p), b), dst[i])));
  return { A, b, res };
}

export function applyAffine(T, p) { return add(mulV(T.A, p), T.b); }
