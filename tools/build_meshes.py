"""Baut aus einem Ultraschall-Volumen (data/<name>/vol.bin.gz) Oberflächenmodelle für die 3D-Anatomieansicht.

Die Meshes stammen aus denselben Gewebeklassen wie das Ultraschallbild, liegen also exakt dort,
wo die Sonde schallt. Koordinaten in mm im RAS-System des Volumens (Index * spacing).

Ausgabe: data/<name>/anatomy.glb mit je einem Mesh pro Struktur (Name = Schlüssel in js/anatomy3d.js)

Aufruf:
  python tools/build_meshes.py --name thorax
  npx @gltf-transform/cli meshopt data/thorax/anatomy.glb data/thorax/anatomy.glb   # komprimiert ca. 5 MB -> 1 MB
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


def surface(mask, spacing, sigma=1.0, faces=8000, smooth=10, up=2):
    """Glatte Oberfläche: Maske auf ein feineres Gitter bringen, weichzeichnen, Marching Cubes, ausdünnen, glätten."""
    if mask.sum() < 50:
        return None
    idx = np.argwhere(mask)
    lo = np.maximum(idx.min(0) - 4, 0)
    hi = np.minimum(idx.max(0) + 5, mask.shape)
    sub = mask[tuple(slice(a, b) for a, b in zip(lo, hi))].astype(np.float32)
    f = np.pad(sub, 2)
    if up > 1:
        f = ndi.zoom(f, up, order=1)
    f = ndi.gaussian_filter(f, sigma * up)
    v, t, _, _ = measure.marching_cubes(f, 0.5)
    v = (v / up - 2 + lo) * spacing
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


def split_bones(cls, body, spacing):
    """Knochen grob nach Lage benennen: Wirbelsäule, Brustbein, Becken, Rippen (Rest, auch Schulter)."""
    bone = cls == BONE
    out = {}
    if not bone.any():
        return out
    pts = np.argwhere(body)
    yc = np.median(pts[:, 1])
    post = np.argwhere(bone & (np.arange(bone.shape[1])[None, :, None] < yc))
    xc = np.median(post[:, 0]) if len(post) else bone.shape[0] / 2   # Mitte der Wirbelsäule
    x = np.abs(np.arange(bone.shape[0]) - xc)[:, None, None] * spacing
    y = np.arange(bone.shape[1])[None, :, None]
    z = np.arange(bone.shape[2])[None, None, :]
    mid = x < 24
    spine = bone & mid & (y < yc)
    sternum = bone & (x < 22) & (y > yc)
    rest = bone & ~spine & ~sternum
    pelvis = np.zeros_like(bone)
    kid = np.isin(cls, [KIDNEY, SINUS])
    if kid.any():
        # Beckenknochen liegen unterhalb der Nieren (unterer Pol minus 1 cm)
        z_low = np.argwhere(kid)[:, 2].min() - int(10 / spacing)
        pelvis = (rest | sternum) & (z < z_low)   # auch Symphyse in der Mitte vorn
        rest &= ~pelvis
        sternum &= ~pelvis
        spine |= bone & mid & (y < yc) & (z < z_low)
    for key, m in (('spine', spine), ('sternum', sternum), ('pelvis', pelvis), ('ribs', rest)):
        if m.sum() > 200:
            out[key] = m
    return out


def build(name, root):
    cls, hu, meta = load(name, root)
    sp = meta['spacing']
    body = ndi.binary_fill_holes(cls != AIR)
    body = largest(body)
    # Rumpfwand: Muskulatur in den äußeren 3,5 cm unter der Haut (Bauchwand, Brustmuskeln, Zwischenrippenmuskeln)
    depth = ndi.distance_transform_edt(body) * sp
    band = (depth > 3) & (depth < 35)
    wall = (cls == MUSCLE) & band
    wall = ndi.binary_opening(wall, iterations=1)
    # Lücken über Rippen und Knorpel schließen, damit die Wand geschlossen wirkt
    wall = ndi.binary_closing(wall | (np.isin(cls, [BONE, CARTILAGE]) & band & (depth < 20)), iterations=2) & band
    # name: (Maske, Weichzeichnung in Voxeln, Dreiecke, Glättungsschritte, Feinheit)
    parts = {
        'skin': (body, 2.0, 30000, 10, 1),
        'muscle': (largest(wall, 3, 500), 1.0, 40000, 10, 1),
        'cartilage': (cls == CARTILAGE, 0.8, 12000, 10, 2),
        'liver': (largest(cls == LIVER), 1.2, 20000, 10, 2),
        'spleen': (largest(cls == SPLEEN), 1.2, 8000, 10, 2),
        'kidney': (largest(np.isin(cls, [KIDNEY, SINUS]), 2, 200), 1.2, 10000, 10, 2),
        'heart': (largest(cls == HEART), 1.2, 16000, 10, 2),
        'bowel': (largest(cls == BOWEL, 20, 100), 1.6, 30000, 20, 2),
        'fluid': (largest(cls == FLUID, 2, 100), 1.2, 6000, 10, 2),
        'lung': (largest((cls == GAS) & ~ndi.binary_dilation(cls == BOWEL, iterations=2), 2, 5000), 1.3, 24000, 10, 1),
    }
    budget = {'spine': 20000, 'sternum': 6000, 'pelvis': 24000, 'ribs': 40000}
    for key, m in split_bones(cls, body, sp).items():
        parts[key] = (m, 0.7, budget[key], 8, 2)
    blood = largest(cls == BLOOD, 6, 30)
    art, ven = split_vessels(blood, sp)
    parts['artery'] = (art, 0.8, 12000, 10, 2)
    parts['vein'] = (ven, 0.8, 12000, 10, 2)

    scene = trimesh.Scene()
    stats = {}
    for key, (mask, sigma, faces, smooth, up) in parts.items():
        m = surface(mask, sp, sigma, faces, smooth, up)
        if m is None:
            continue
        if key in ('skin', 'muscle'):
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
