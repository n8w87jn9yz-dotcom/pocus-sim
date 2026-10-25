// Geglättete Gewebefelder für den Shader: Rückstreuung, Fettanteil, Impedanz, Knochen- und Gasanteil.
// Das CT liegt in 1,5-2-mm-Voxeln vor. Nächster Nachbar ergäbe Treppen an jeder Organgrenze, an Rippen
// und an der Pleura. Ein Binomialfilter [1 2 1] je Achse plus trilineare Filterung der Grafikkarte macht
// daraus runde Grenzen. Die schlagenden Herzhöhlen rechnet der Shader selbst dazu.

import { TISSUES } from './common.js';

const FAT = 2, GAS = 1, BONE = 10, BLOOD = 8, FLUID = 12, AIR = 0;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Kodierung wie in tissue() im Shader
const CHANNELS = [
  c => c === FAT ? 0 : TISSUES[c].scat / 3,
  // Bindegewebssepten im Fett sind im CT dichter: daraus wird die helle Streifung
  (c, hu) => c === FAT ? (0.55 + 2.2 * smooth(-110, -45, hu)) / 2.75 : 0,
  (c, hu) => {
    const t = TISSUES[c];
    const plain = c === AIR || c === GAS || c === BONE || c === BLOOD || c === FLUID;
    const mod = plain ? 0 : 0.0005 * clamp(hu - t.hu, -60, 60);
    return (t.z * (1 + mod) - 1.3) / 0.7;
  },
  c => c === BONE ? 1 : 0,
  // zweite Textur: Gas und die Bereiche der Fälle (freie Flüssigkeit), Bits wie FINDINGS in common.js.
  // Perikard (4) und Becken (8) teilen sich einen Kanal, sie liegen nie im selben Schallfenster.
  c => c === GAS ? 1 : 0,
  (c, hu, p) => c !== BONE && (p & 1) ? 1 : 0,
  (c, hu, p) => c !== BONE && (p & 2) ? 1 : 0,
  (c, hu, p) => c !== BONE && (p & 12) ? 1 : 0,
];

export function buildFields(data, dims) {
  const [dx, dy, dz] = dims, n = dx * dy * dz;
  const A = new Uint8Array(4 * n), B = new Uint8Array(4 * n);
  let a = new Float32Array(n), t = new Float32Array(n);
  CHANNELS.forEach((fn, k) => {
    for (let i = 0; i < n; i++) a[i] = fn(data[4 * i], data[4 * i + 1] * 8 - 1000, data[4 * i + 3]);
    for (let axis = 0; axis < 3; axis++) { blur(a, t, dims, axis); [a, t] = [t, a]; }
    const out = k < 4 ? A : B, o = k % 4;
    for (let i = 0; i < n; i++) out[4 * i + o] = Math.round(clamp(a[i], 0, 1) * 255);
  });
  return { A, B };
}

function blur(src, dst, [dx, dy, dz], axis) {
  const st = [1, dx, dx * dy][axis], len = [dx, dy, dz][axis];
  let i = 0;
  for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++, i++) {
    const p = axis === 0 ? x : axis === 1 ? y : z;
    dst[i] = 0.25 * (src[p > 0 ? i - st : i] + 2 * src[i] + src[p < len - 1 ? i + st : i]);
  }
}

// Herzfeld für das Subxiphoidalfenster (zweikanalig, siehe uHrt im Shader):
//   R = Abstand zur nächsten Wand (Außenfläche, Septum, Klappenebene) in 1/8 mm, Ecken weich verrundet,
//       damit die Kammern rund statt kastenförmig werden
//   G = vorzeichenbehafteter Abstand zur Herzoberfläche in 1/8 mm um 128 (innen positiv), für das Perikard
// Dazu Herzmitte und Längsachse für die Herzbewegung im Shader. Echte euklidische Abstände
// statt der gestuften Werte aus dem Volumen.
const HEART = 9;
export function buildHeart(data, dims, spacing) {
  const [dx, dy, dz] = dims, n = dx * dy * dz;
  const inside = new Uint8Array(n);
  let cnt = 0;
  const c = [0, 0, 0];
  for (let i = 0, z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++, i++) {
    if (data[4 * i] !== HEART) continue;
    inside[i] = 1; cnt++;
    c[0] += x; c[1] += y; c[2] += z;
  }
  if (cnt < 100) return null;
  for (let k = 0; k < 3; k++) c[k] = c[k] / cnt * spacing;
  // Hauptachsen wie in tools/build_volume.py (heart_aux)
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const ax = [0, 0, 0];
  for (let i = 0, z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++, i++) {
    if (!inside[i]) continue;
    const p = [x * spacing - c[0], y * spacing - c[1], z * spacing - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += p[a] * p[b] / cnt;
  }
  const [longAx, shortAx] = eigTop2(C);
  if (longAx[0] * -1 + longAx[1] - longAx[2] < 0) longAx.forEach((v, k) => { longAx[k] = -v; });
  if (-shortAx[0] - shortAx[1] < 0) shortAx.forEach((v, k) => { shortAx[k] = -v; });
  let amin = Infinity, amax = -Infinity;
  for (let i = 0, z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++, i++) {
    if (!inside[i]) continue;
    const a = (x * spacing - c[0]) * longAx[0] + (y * spacing - c[1]) * longAx[1] + (z * spacing - c[2]) * longAx[2];
    amin = Math.min(amin, a); amax = Math.max(amax, a);
  }
  const valve = -0.15 * (amax - amin);
  // drittes Achsenkreuz-Bein: quer zu Längsachse und Septumrichtung
  const e3 = [longAx[1] * shortAx[2] - longAx[2] * shortAx[1], longAx[2] * shortAx[0] - longAx[0] * shortAx[2], longAx[0] * shortAx[1] - longAx[1] * shortAx[0]];
  const dIn = edt(inside, dims, 1), dOut = edt(inside, dims, 0);
  const out = new Uint8Array(2 * n);
  // weiches Minimum: verrundet die Ecken, an denen Septum, Klappenebene und Außenwand zusammentreffen
  const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
  for (let i = 0, z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++, i++) {
    const di = Math.sqrt(dIn[i]) * spacing, dO = Math.sqrt(dOut[i]) * spacing;
    const sd = inside[i] ? di - 0.5 * spacing : -(dO - 0.5 * spacing);
    out[2 * i + 1] = Math.round(clamp(128 + sd * 8, 0, 255));
    if (!inside[i]) continue;
    const p = [x * spacing - c[0], y * spacing - c[1], z * spacing - c[2]];
    const along = p[0] * longAx[0] + p[1] * longAx[1] + p[2] * longAx[2];
    const side = p[0] * shortAx[0] + p[1] * shortAx[1] + p[2] * shortAx[2];
    // Das Septum wölbt sich in den rechten Ventrikel (linker Ventrikel im Querschnitt rund, Radius ~35 mm)
    const t = p[0] * e3[0] + p[1] * e3[1] + p[2] * e3[2];
    let d = smin(sd, Math.abs(side - t * t / 70) + 1.0, 5);
    d = smin(d, Math.abs(along - valve) + 2.0, 5);
    out[2 * i] = Math.round(clamp(d * 8, 0, 255));
  }
  return { tex: out, center: c, axis: longAx };
}

// Quadrierter euklidischer Abstand (in Voxeln²) jedes Voxels zum nächsten Voxel mit mask != val
// (Felzenszwalb & Huttenlocher, je Achse eine 1D-Transformation)
function edt(mask, [dx, dy, dz], val) {
  const n = dx * dy * dz, INF = 1e12;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = mask[i] === val ? INF : 0;
  const L = Math.max(dx, dy, dz);
  const g = new Float64Array(L), v = new Int32Array(L), zz = new Float64Array(L + 1), r = new Float64Array(L);
  const pass = (len, st, starts) => {
    for (const s0 of starts) {
      for (let q = 0; q < len; q++) g[q] = f[s0 + q * st];
      let k = 0; v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
      for (let q = 1; q < len; q++) {
        let s;
        for (;;) {
          const p = v[k];
          s = ((g[q] + q * q) - (g[p] + p * p)) / (2 * q - 2 * p);
          if (s <= zz[k] && k > 0) k--; else break;
        }
        if (s <= zz[k]) { v[0] = q; zz[0] = -Infinity; zz[1] = Infinity; k = 0; continue; }
        k++; v[k] = q; zz[k] = s; zz[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (zz[k + 1] < q) k++;
        r[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
      }
      for (let q = 0; q < len; q++) f[s0 + q * st] = Math.min(r[q], INF);
    }
  };
  const rows = function* (a) {
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) {
      if ((a === 0 && x === 0) || (a === 1 && y === 0) || (a === 2 && z === 0)) yield x + dx * (y + dy * z);
    }
  };
  pass(dx, 1, rows(0));
  pass(dy, dx, rows(1));
  pass(dz, dx * dy, rows(2));
  return f;
}

// Die zwei größten Eigenvektoren einer symmetrischen 3x3-Matrix (Jacobi-Verfahren)
function eigTop2(A) {
  const a = A.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1;
    if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
    if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) < 1e-9) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const cs = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq;
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return order.slice(0, 2).map(j => [V[0][j], V[1][j], V[2][j]]);
}
