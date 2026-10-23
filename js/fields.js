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
