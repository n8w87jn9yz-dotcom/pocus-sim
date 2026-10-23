"""Wandelt ein CT plus TotalSegmentator-Segmentierung in ein Ultraschall-Volumen für den Browser um.

Ausgabe (data/<name>/):
  vol.bin.gz  RGBA8 je Voxel, x schnellste Achse, RAS-Orientierung
              R = Gewebeklasse, G = HU (-1000..1040 in 8-HU-Schritten),
              B = Herz: Abstand zur nächsten Wand in 0,5 mm, A = Bitmaske Pathologien
  meta.json   Gitter, Voxelgröße und Schallfenster (Ursprung auf der Haut, Achsen)

Aufruf:
  python tools/build_volume.py --ct ct.nii.gz --seg seg.nii.gz --name thorax --windows ruq,luq,subxiphoid,lung_r,lung_l
"""
import argparse
import gzip
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi

# Gewebeklassen, gleiche Nummern wie im Shader
AIR, GAS, FAT, SOFT, LIVER, SPLEEN, KIDNEY, SINUS, BLOOD, HEART, BONE, BOWEL, FLUID, SKIN, MUSCLE, CARTILAGE = range(16)

# Pathologie-Bits, gleiche Werte wie FINDINGS in js/common.js
P_MORISON, P_LUQ, P_PERICARD, P_PELVIS = 1, 2, 4, 8

# TotalSegmentator-Klassen (Task "total") nach Name
GROUPS = {
    LIVER: ['liver'],
    SPLEEN: ['spleen'],
    KIDNEY: ['kidney_right', 'kidney_left'],
    BLOOD: ['aorta', 'inferior_vena_cava', 'portal_vein_and_splenic_vein', 'superior_vena_cava', 'pulmonary_vein',
            'brachiocephalic_trunk', 'subclavian_artery_right', 'subclavian_artery_left',
            'common_carotid_artery_right', 'common_carotid_artery_left', 'brachiocephalic_vein_left',
            'brachiocephalic_vein_right', 'iliac_artery_left', 'iliac_artery_right', 'iliac_vena_left',
            'iliac_vena_right', 'atrial_appendage_left'],
    HEART: ['heart'],
    BOWEL: ['stomach', 'small_bowel', 'duodenum', 'colon', 'esophagus'],
    FLUID: ['urinary_bladder', 'gallbladder'],
    GAS: ['lung_upper_lobe_left', 'lung_lower_lobe_left', 'lung_upper_lobe_right', 'lung_middle_lobe_right',
          'lung_lower_lobe_right', 'trachea'],
    MUSCLE: ['autochthon_left', 'autochthon_right', 'iliopsoas_left', 'iliopsoas_right', 'gluteus_maximus_left',
             'gluteus_maximus_right', 'gluteus_medius_left', 'gluteus_medius_right', 'gluteus_minimus_left',
             'gluteus_minimus_right'],
    CARTILAGE: ['costal_cartilages'],
    SOFT: ['pancreas', 'adrenal_gland_right', 'adrenal_gland_left', 'thyroid_gland', 'prostate', 'spinal_cord'],
}
BONE_PREFIX = ('rib_', 'vertebrae_', 'sternum', 'scapula', 'clavicula', 'humerus', 'hip_', 'sacrum', 'femur')


def load(ct_path, seg_path, spacing):
    ct = nib.as_closest_canonical(nib.load(ct_path))
    seg = nib.as_closest_canonical(nib.load(seg_path))
    zoom = np.array(ct.header.get_zooms()[:3]) / spacing
    hu = ndi.zoom(ct.get_fdata(dtype=np.float32), zoom, order=1)
    lab = ndi.zoom(np.asarray(seg.dataobj).astype(np.int16), zoom, order=0)
    return hu, lab


def body_mask(hu):
    m = hu > -400
    lbl, n = ndi.label(m)
    sizes = ndi.sum(m, lbl, range(1, n + 1))
    m = lbl == (np.argmax(sizes) + 1)
    for z in range(m.shape[2]):
        m[:, :, z] = ndi.binary_fill_holes(m[:, :, z])
    return m


def classify(hu, lab, names, spacing):
    body = body_mask(hu)
    cls = np.full(hu.shape, AIR, np.uint8)
    # unbenanntes Gewebe nach HU
    cls[body & (hu < -30)] = FAT
    cls[body & (hu >= -30)] = MUSCLE
    cls[body & (hu > 200)] = BONE
    cls[body & (hu < -400)] = GAS
    by_name = {n: i for i, n in names.items()}
    for c, group in GROUPS.items():
        ids = [by_name[n] for n in group if n in by_name]
        cls[np.isin(lab, ids)] = c
    bone_ids = [i for i, n in names.items() if n.startswith(BONE_PREFIX)]
    cls[np.isin(lab, bone_ids)] = BONE
    # Darm: luftgefüllte Anteile als Gas
    cls[(cls == BOWEL) & (hu < -200)] = GAS
    # Nierensinus: Fett im Nierenhilus oder tiefer Anteil der Niere
    kid = cls == KIDNEY
    depth_in = ndi.distance_transform_edt(kid) * spacing
    cls[kid & ((hu < -20) | (depth_in > 9))] = SINUS
    # Haut: die äußersten 2 mm
    skin = body & (ndi.distance_transform_edt(body) * spacing <= 2.0)
    cls[skin & (cls != BONE)] = SKIN
    lung = np.isin(lab, [by_name[n] for n in GROUPS[GAS] if n in by_name])
    sternum = lab == by_name['sternum']
    return cls, {'body': body, 'lung': lung, 'sternum': sternum}


def heart_aux(cls, spacing):
    """Abstand zur nächsten Herzwand (Außenfläche oder Septum) in 0,5 mm.

    Die Kammern sind im nativen CT nicht sichtbar. Sie werden deshalb aus der echten Herzkontur
    abgeleitet: Hauptachsen des Herzens bestimmen Septum und Klappenebene.
    """
    heart = cls == HEART
    aux = np.zeros(cls.shape, np.uint8)
    if heart.sum() < 100:
        return aux
    idx = np.argwhere(heart).astype(np.float32) * spacing
    c = idx.mean(0)
    _, vecs = np.linalg.eigh(np.cov((idx - c).T))
    long_ax, short_ax = vecs[:, 2], vecs[:, 1]
    grid = np.stack(np.meshgrid(*[np.arange(s, dtype=np.float32) * spacing for s in cls.shape], indexing='ij'), -1) - c.astype(np.float32)
    d_septum = np.abs(grid @ short_ax)                         # Septum entlang der Längsachse
    d_valve = np.abs(grid @ long_ax + 0.15 * np.ptp(idx @ long_ax))  # Klappenebene etwas zur Basis verschoben
    d_out = ndi.distance_transform_edt(heart) * spacing
    d = np.minimum(np.minimum(d_out, d_septum + 1.0), d_valve + 2.0)
    aux[heart] = np.clip(d[heart] * 2, 0, 255).astype(np.uint8)
    return aux


def pathology(cls, body, spacing):
    path = np.zeros(cls.shape, np.uint8)
    free = body & np.isin(cls, [FAT, MUSCLE, SOFT, BOWEL])

    def near(mask, mm):
        return ndi.distance_transform_edt(~mask) * spacing < mm if mask.any() else np.zeros_like(mask)

    liver, spleen, heart = cls == LIVER, cls == SPLEEN, cls == HEART
    kid = np.isin(cls, [KIDNEY, SINUS])
    x_mid = cls.shape[0] // 2
    kid_r, kid_l = kid.copy(), kid.copy()
    kid_r[:x_mid] = False   # RAS: große x = rechts
    kid_l[x_mid:] = False
    path[free & near(liver, 7) & near(kid_r, 9)] |= P_MORISON
    path[free & near(spleen, 7) & (near(kid_l, 9) | near(cls == GAS, 6))] |= P_LUQ
    if heart.any():
        shell = near(heart, 9) & ~heart & ~(cls == BONE)
        path[shell] |= P_PERICARD
    bladder = (cls == FLUID) & near(np.isin(cls, [BONE]), 80)
    if bladder.any():
        bz = np.argwhere(bladder)
        y_post = bz[:, 1].min()
        region = free & near(bladder, 25) & ~bladder
        region[:, y_post + int(25 / spacing):, :] = False   # vor allem hinter und über der Blase
        path[region] |= P_PELVIS
    return path


def skin_point(body, start_vox, direction, spacing):
    """Vom Punkt im Körper entlang direction laufen, bis der Körper endet."""
    p = np.array(start_vox, np.float32)
    d = np.asarray(direction, np.float32)
    d /= np.linalg.norm(d)
    for _ in range(2000):
        q = p + d * 0.5
        i = np.round(q).astype(int)
        if np.any(i < 0) or np.any(i >= body.shape) or not body[tuple(i)]:
            return p * spacing
        p = q
    return p * spacing


def basis(depth, lateral_hint):
    D = np.asarray(depth, float); D /= np.linalg.norm(D)
    L = np.asarray(lateral_hint, float); L -= D * (L @ D); L /= np.linalg.norm(L)
    E = np.cross(L, D)
    return L, D, E


def centroid(mask):
    return np.argwhere(mask).mean(0)


def upper_contact(organ, kidney, spacing):
    """Kontaktzone Organ/Niere am oberen Nierenpol."""
    contact = np.argwhere(np.logical_and(ndi.binary_dilation(organ, iterations=4), kidney))
    if len(contact) == 0:
        contact = np.argwhere(kidney)
    top = contact[contact[:, 2] >= np.percentile(contact[:, 2], 50)].mean(0)
    return top


def make_windows(cls, masks, spacing, wanted):
    body = masks['body']
    R, A, S = np.eye(3)  # RAS-Einheitsvektoren
    out = {}
    liver, spleen, heart, gas = cls == LIVER, cls == SPLEEN, cls == HEART, cls == GAS
    kid = np.isin(cls, [KIDNEY, SINUS])
    x_mid = cls.shape[0] // 2

    bone = cls == BONE

    def bone_score(origin_mm, L, D, E):
        n = 0
        for d in range(0, 60, 2):
            for l in range(-8, 9, 2):
                for e in (-3, 0, 3):
                    i = np.round((origin_mm + D * d + L * l + E * e) / spacing).astype(int)
                    if np.all(i >= 0) and np.all(i < bone.shape) and bone[tuple(i)]:
                        n += 1
        return n

    def clear_origin(target_vox, L, D, E):
        """Nächstgelegenen Ansatzpunkt suchen, unter dem keine Rippe liegt (Interkostalraum)."""
        best = None
        for r in range(0, 31, 3):
            for a in np.linspace(0, 2 * np.pi, 1 if r == 0 else 12, endpoint=False):
                shift = (L * np.cos(a) + E * np.sin(a)) * r / spacing
                o = skin_point(body, target_vox + shift, -D, spacing)
                sc = bone_score(o, L, D, E)
                if best is None or sc < best[0]:
                    best = (sc, o)
            if best[0] == 0:
                break
        return best[1]

    def add(key, target_vox, depth, lateral):
        L, D, E = basis(depth, lateral)
        origin = clear_origin(np.asarray(target_vox, float), L, D, E)
        out[key] = {'origin': origin.round(1).tolist(), 'L': L.round(4).tolist(), 'D': D.round(4).tolist(),
                    'E': E.round(4).tolist()}

    if 'ruq' in wanted:
        kr = kid.copy(); kr[:x_mid] = False
        t = upper_contact(liver, kr, spacing)
        add('ruq', t, -R, -S)                                  # von rechts lateral, Marker kranial
    if 'luq' in wanted:
        kl = kid.copy(); kl[x_mid:] = False
        t = upper_contact(spleen, kl, spacing)
        add('luq', t, R + 0.15 * A, -S)                        # von links posterolateral
    if 'subxiphoid' in wanted:
        hc = centroid(heart)
        st = np.argwhere(masks['sternum'])
        # knapp unter der Xiphoidspitze ansetzen
        zmin = st[:, 2].min() if len(st) else int(hc[2]) - 40
        xs = np.median(st[:, 0]) if len(st) else hc[0]
        start = np.array([xs, hc[1], zmin - 15 / spacing])
        o = skin_point(body, start, A, spacing)
        L, D, E = basis(hc * spacing - o, -R)                  # Marker zur rechten Patientenseite
        o = clear_origin(o / spacing + D * (20 / spacing), L, D, E)
        out['subxiphoid'] = {'origin': o.round(1).tolist(), 'L': L.round(4).tolist(),
                             'D': D.round(4).tolist(), 'E': E.round(4).tolist()}
    for key, side in (('lung_r', 1), ('lung_l', -1)):
        if key not in wanted:
            continue
        lung = masks['lung'].copy()
        if side > 0:
            lung[:x_mid] = False
        else:
            lung[x_mid:] = False
        pts = np.argwhere(lung)
        zc = np.percentile(pts[:, 2], 70)                      # oberes Lungendrittel (2.–3. ICR)
        sel = pts[np.abs(pts[:, 2] - zc) < 4]
        xc = np.median(sel[:, 0])                              # etwa Medioklavikularlinie
        sel = sel[np.abs(sel[:, 0] - xc) < 4]
        t = sel[np.argmax(sel[:, 1])].astype(float)            # vorderster Lungenpunkt
        add(key, t, -A, -S)                                    # sagittal, Marker kranial
    if 'pelvis' in wanted:
        t = centroid(cls == FLUID)
        add('pelvis', t, -A - 0.3 * S, -R)                     # transversal, leicht nach kaudal gekippt
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ct', required=True)
    ap.add_argument('--seg', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--windows', required=True)
    ap.add_argument('--spacing', type=float, default=1.5)
    ap.add_argument('--source', default='')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'data'))
    a = ap.parse_args()

    from totalsegmentator.map_to_binary import class_map
    names = class_map['total']

    hu, lab = load(a.ct, a.seg, a.spacing)
    cls, masks = classify(hu, lab, names, a.spacing)
    body = masks['body']
    # auf den Körper zuschneiden (plus Rand)
    lo = np.maximum(np.argwhere(body).min(0) - 4, 0)
    hi = np.minimum(np.argwhere(body).max(0) + 5, body.shape)
    sl = tuple(slice(l, h) for l, h in zip(lo, hi))
    hu, cls = hu[sl], cls[sl]
    masks = {k: v[sl] for k, v in masks.items()}
    body = masks['body']

    aux = heart_aux(cls, a.spacing)
    path = pathology(cls, body, a.spacing)
    windows = make_windows(cls, masks, a.spacing, a.windows.split(','))

    huq = np.clip((hu + 1000) / 8, 0, 255).astype(np.uint8)
    vol = np.stack([cls, huq, aux, path], -1)                  # (x, y, z, 4)
    vol = np.ascontiguousarray(vol.transpose(2, 1, 0, 3))      # x schnellste Achse im Speicher

    out = Path(a.out) / a.name
    out.mkdir(parents=True, exist_ok=True)
    with gzip.open(out / 'vol.bin.gz', 'wb', compresslevel=9) as f:
        f.write(vol.tobytes())
    meta = {'dims': [int(s) for s in cls.shape], 'spacing': a.spacing, 'windows': windows, 'source': a.source}
    (out / 'meta.json').write_text(json.dumps(meta, indent=1))
    print(out, meta['dims'], {k: v['origin'] for k, v in windows.items()},
          f'{(out / "vol.bin.gz").stat().st_size / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
