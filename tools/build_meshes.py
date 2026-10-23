"""Baut aus einem Ultraschall-Volumen (data/<name>/vol.bin.gz) Oberflächenmodelle für die 3D-Anatomieansicht.

Die Meshes stammen aus denselben Gewebeklassen wie das Ultraschallbild, liegen also exakt dort,
wo die Sonde schallt. Koordinaten in mm im RAS-System des Volumens (Index * spacing).

Ausgabe: data/<name>/anatomy.glb mit je einem Mesh pro Struktur (Name = Schlüssel in js/anatomy3d.js)

Aufruf:
  python tools/build_meshes.py --name thorax
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage as ndi
from skimage import measure

AIR, GAS, FAT, SOFT, LIVER, SPLEEN, KIDNEY, SINUS, BLOOD, HEART, BONE, BOWEL, FLUID, SKIN, MUSCLE, CARTILAGE = range(16)


def load(name, root):
    meta = json.loads((root / name / 'meta.json').read_text())
    nx, ny, nz = meta['dims']
    raw = gzip.open(root / name / 'vol.bin.gz').read()
    vol = np.frombuffer(raw, np.uint8).reshape(nz, ny, nx, 4).transpose(2, 1, 0, 3)
    return vol[..., 0], vol[..., 1].astype(np.float32) * 8 - 1000, meta


def largest(mask, keep=1, min_vox=0):
    lbl, n = ndi.label(mask)
    if n == 0:
        return mask
    sizes = ndi.sum(mask, lbl, range(1, n + 1))
    order = np.argsort(sizes)[::-1][:keep]
    return np.isin(lbl, [i + 1 for i in order if sizes[i] >= min_vox])


def surface(mask, spacing, sigma=1.0, faces=8000, smooth=10):
    if mask.sum() < 50:
        return None
    pad = np.pad(mask.astype(np.float32), 2)
    f = ndi.gaussian_filter(pad, sigma)
    v, t, _, _ = measure.marching_cubes(f, 0.5)
    v = (v - 2) * spacing
    m = trimesh.Trimesh(v, t, process=True)
    if len(m.faces) > faces:
        m = m.simplify_quadric_decimation(face_count=faces)
    trimesh.smoothing.filter_taubin(m, iterations=smooth)
    m.fix_normals()
    return m


def open_caps(m, shape, spacing):
    """Schnittflächen am oberen und unteren Rand des CT entfernen: die Haut wird zur offenen Hülle."""
    z = m.vertices[:, 2]
    lo, hi = 1.5 * spacing, (shape[2] - 2.5) * spacing
    cap = np.all((z[m.faces] < lo) | (z[m.faces] > hi), axis=1)
    m.update_faces(~cap)
    m.remove_unreferenced_vertices()
    return m


def split_vessels(blood, spacing):
    """Gefäße in arteriell und venös trennen (Aorta links, V. cava rechts der Mittellinie)."""
    pts = np.argwhere(blood)
    if len(pts) == 0:
        return blood, blood
    # Abstand zum dicksten Gefäßstrang: Mittelpunkt je Schicht liegt zwischen Aorta und IVC
    art = np.zeros_like(blood)
    for z in range(blood.shape[2]):
        sl = blood[:, :, z]
        if not sl.any():
            continue
        lbl, n = ndi.label(sl)
        for i in range(1, n + 1):
            c = np.argwhere(lbl == i).mean(0)
            # RAS: kleines x = links → Aorta; tiefer liegend (kleines y = posterior) ebenfalls eher Aorta
            if c[0] < blood.shape[0] * 0.5 + 6 / spacing:
                art[:, :, z] |= lbl == i
    return art, blood & ~art


def build(name, root):
    cls, hu, meta = load(name, root)
    sp = meta['spacing']
    body = ndi.binary_fill_holes(cls != AIR)
    body = largest(body)
    parts = {
        'skin': (body, 2.0, 12000),
        'bone': (cls == BONE, 0.7, 30000),
        'cartilage': (cls == CARTILAGE, 0.7, 6000),
        'liver': (largest(cls == LIVER), 1.0, 8000),
        'spleen': (largest(cls == SPLEEN), 1.0, 3000),
        'kidney': (largest(np.isin(cls, [KIDNEY, SINUS]), 2, 200), 1.0, 5000),
        'heart': (largest(cls == HEART), 1.0, 8000),
        'bowel': (largest(cls == BOWEL, 20, 100), 1.5, 12000),
        'fluid': (largest(cls == FLUID, 2, 100), 1.0, 3000),
        'lung': (largest((cls == GAS) & ~ndi.binary_dilation(cls == BOWEL, iterations=2), 2, 5000), 1.2, 12000),
    }
    blood = largest(cls == BLOOD, 6, 30)
    art, ven = split_vessels(blood, sp)
    parts['artery'] = (art, 0.8, 6000)
    parts['vein'] = (ven, 0.8, 6000)

    scene = trimesh.Scene()
    stats = {}
    for key, (mask, sigma, faces) in parts.items():
        m = surface(mask, sp, sigma, faces)
        if m is None:
            continue
        if key == 'skin':
            m = open_caps(m, cls.shape, sp)
        scene.add_geometry(m, node_name=key, geom_name=key)
        stats[key] = len(m.faces)
    out = root / name / 'anatomy.glb'
    scene.export(out)
    print(out, f'{out.stat().st_size / 1e6:.2f} MB', stats)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--data', default=str(Path(__file__).resolve().parent.parent / 'data'))
    a = ap.parse_args()
    build(a.name, Path(a.data))


if __name__ == '__main__':
    main()
