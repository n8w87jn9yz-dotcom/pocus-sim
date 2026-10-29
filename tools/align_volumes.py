"""Bestimmt die Verschiebung zwischen zwei Ausschnitten desselben CT-Falls und schreibt sie als
`offset` (mm) in die meta.json des zweiten Volumens, so dass  p_ref = p_vol + offset.

Thorax und Abdomen stammen beide aus Fall s0662, wurden aber getrennt zugeschnitten und neu abgetastet.
Für die Quest-Version (xr.html) braucht es einen gemeinsamen Körper-Koordinatenraum, in dem die Sonde
frei von der Lunge bis zum Becken wandern kann. Gesucht wird nur eine Translation (gleiche Ausrichtung, RAS):
grob über die Schichtprofile von Leber, Lunge und Knochen (z) und die Knochenschwerpunkte (x, y),
fein über die Knochenüberlappung in 1-mm-Schritten.

    python tools/align_volumes.py --ref abdomen --vol thorax
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent.parent / 'data'


def load(name):
    meta = json.loads((DATA / name / 'meta.json').read_text())
    raw = gzip.decompress((DATA / name / 'vol.bin.gz').read_bytes())
    dx, dy, dz = meta['dims']
    cls = np.frombuffer(raw, np.uint8).reshape(dz, dy, dx, 4)[..., 0].transpose(2, 1, 0)  # x, y, z
    return meta, cls


def profiles(cls, spacing):
    """Fläche (cm²) von Leber, Lunge und Knochen je Schicht, auf 1 mm in z umgetastet."""
    z = np.arange(0, cls.shape[2] * spacing, 1.0)
    out = []
    for c in (4, 1, 10):
        a = (cls == c).sum((0, 1)) * spacing * spacing / 100
        out.append(np.interp(z, np.arange(cls.shape[2]) * spacing, a))
    return np.stack(out, 1)


def z_shift(pa, pb, min_overlap=60):
    """Verschiebung in z (mm), bei der die Schichtprofile von b am besten auf a passen."""
    best = (np.inf, 0)
    for d in range(-len(pb) + min_overlap, len(pa) - min_overlap):
        i0, i1 = max(0, d), min(len(pa), d + len(pb))
        e = np.abs(pa[i0:i1] - pb[i0 - d:i1 - d]).mean()
        if e < best[0]:
            best = (e, d)
    return best[1]


def centroid_xy(cls, spacing, z0, z1):
    k0, k1 = int(z0 / spacing), int(z1 / spacing)
    return np.argwhere(cls[:, :, k0:k1] == 10)[:, :2].mean(0) * spacing


def score(ra, rs, va, vs, off):
    """Anteil der Knochenpunkte von va, die bei Verschiebung off (mm) in ra ebenfalls Knochen treffen."""
    pts = np.argwhere(va == 10)[::7] * vs + off
    idx = np.floor(pts / rs).astype(int)
    ok = np.all((idx >= 0) & (idx < ra.shape), axis=1)
    if ok.sum() < 500:
        return 0.0
    i = idx[ok]
    return float((ra[i[:, 0], i[:, 1], i[:, 2]] == 10).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', default='abdomen')
    ap.add_argument('--vol', default='thorax')
    args = ap.parse_args()
    mr, cr = load(args.ref)
    mv, cv = load(args.vol)
    rs, vs = mr['spacing'], mv['spacing']
    dz = z_shift(profiles(cr, rs), profiles(cv, vs))
    # Überlappung in z, dort die Knochenschwerpunkte in x/y angleichen
    z0, z1 = max(0, dz), min(cr.shape[2] * rs, dz + cv.shape[2] * vs)
    cxy = centroid_xy(cr, rs, z0, z1) - centroid_xy(cv, vs, z0 - dz, z1 - dz)
    off = np.array([cxy[0], cxy[1], dz], float)
    print(f'grob: {off.round(1).tolist()} mm, Überlappung z {z0:.0f}-{z1:.0f} mm')
    best = (score(cr, rs, cv, vs, off), off)
    for d in np.stack(np.meshgrid(*[np.arange(-6, 7)] * 3, indexing='ij'), -1).reshape(-1, 3):
        s = score(cr, rs, cv, vs, off + d)
        if s > best[0]:
            best = (s, off + d)
    s, off = best
    print(f'{args.vol} -> {args.ref}: offset {off.round(1).tolist()} mm, Knochenüberlappung {s:.2f}')
    mv['offset'] = [round(float(v), 1) for v in off]
    mv['offset_ref'] = args.ref
    (DATA / args.vol / 'meta.json').write_text(json.dumps(mv, indent=1))


if __name__ == '__main__':
    main()
