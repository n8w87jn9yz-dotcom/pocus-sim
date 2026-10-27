"""Schematisch ergänzte Gefäßäste für die 3D-Anatomieansicht (nicht im Ultraschallbild).

Der CT-Fall (TotalSegmentator s0662) enthält nur die großen Stämme. Die Hauptäste werden hier nach Lehrbuchlage
als Röhren an die segmentierten Gefäße angesetzt, verankert an Landmarken aus demselben Volumen (Aorta, V. cava,
Pfortader, Nierenbecken, Milz, Leber, Herzhöhlen). Lage und Kaliber sind Orientierung, keine Messung.

Lehrbuchlage (u. a. Sobotta, Prometheus):
- Truncus coeliacus aus der Aortenvorderwand (Th12/L1), nach 1–2 cm Dreiteilung: A. hepatica communis nach rechts
  zur Leberpforte, A. lienalis geschlängelt am Pankreasoberrand zum Milzhilus, A. gastrica sinistra nach links oben.
- A. mesenterica superior ca. 1 cm darunter, zieht vor der V. renalis sinistra und hinter der V. lienalis nach kaudal.
- Aa. renales knapp darunter seitlich zur Niere, die rechte hinter der V. cava. V. renalis sinistra kreuzt vor der
  Aorta unterhalb des AMS-Abgangs (Aorto-mesenteriale Zange), die rechte ist kurz.
- A. mesenterica inferior auf Höhe L3 links vorn aus der Aorta, nach links kaudal.
- Vv. hepaticae (rechte, mittlere, linke) münden unter dem Zwerchfell von vorn in die V. cava.
- A. und V. iliaca interna zweigen in Höhe des Iliosakralgelenks nach dorsal-kaudal ins kleine Becken ab,
  die Vene dorsal der Arterie.
- Truncus pulmonalis aus dem rechten Ventrikel links vor der Aorta ascendens nach hinten oben, Teilung unter dem
  Aortenbogen; A. pulmonalis dextra hinter Aorta ascendens und V. cava superior zum rechten Hilus, sinistra
  über den linken Hauptbronchus zum linken Hilus.
"""
import numpy as np
import trimesh
from scipy import ndimage as ndi

KIDNEY, SINUS, BLOOD, HEART, LIVER, SPLEEN = 6, 7, 8, 9, 4, 5


def _spline(pts, n=24):
    """Catmull-Rom durch die Stützpunkte."""
    p = np.asarray(pts, float)
    p = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1:i + 3]
        for t in np.linspace(0, 1, n, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(p[-2])
    return np.array(out)


def tube(pts, r0, r1=None, seg=14):
    """Röhre entlang einer Kurve, Radius linear von r0 nach r1, Enden geschlossen."""
    c = _spline(pts)
    r1 = r0 if r1 is None else r1
    n = len(c)
    tan = np.gradient(c, axis=0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True)
    # rotationsminimierte Rahmen
    ref = np.array([0, 0, 1.0]) if abs(tan[0][2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(tan[0], ref); u /= np.linalg.norm(u)
    us = [u]
    for i in range(1, n):
        u = us[-1] - np.dot(us[-1], tan[i]) * tan[i]
        u /= np.linalg.norm(u)
        us.append(u)
    us = np.array(us); vs = np.cross(tan, us)
    rad = np.linspace(r0, r1, n)
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ring = (np.cos(ang)[None, :, None] * us[:, None] + np.sin(ang)[None, :, None] * vs[:, None]) * rad[:, None, None]
    v = (c[:, None] + ring).reshape(-1, 3)
    f = []
    for i in range(n - 1):
        for j in range(seg):
            a, b = i * seg + j, i * seg + (j + 1) % seg
            f += [[a, b + seg, b], [a, a + seg, b + seg]]
    v = np.vstack([v, c[0], c[-1]])
    s, e = len(v) - 2, len(v) - 1
    for j in range(seg):
        f.append([s, (j + 1) % seg, j])
        f.append([e, (n - 1) * seg + j, (n - 1) * seg + (j + 1) % seg])
    m = trimesh.Trimesh(v, np.array(f), process=True)
    m.fix_normals()
    return m


def _line(mask, sp):
    """Mittellinie eines Gefäßes je Schicht: z -> (Mittelpunkt, Radius) in mm."""
    out = {}
    for z in range(mask.shape[2]):
        sl = mask[:, :, z]
        if sl.sum() < 4:
            continue
        lbl, n = ndi.label(sl)
        k = np.argmax(ndi.sum(sl, lbl, range(1, n + 1))) + 1
        p = np.argwhere(lbl == k)
        out[z] = (np.r_[p.mean(0) * sp, z * sp], np.sqrt((lbl == k).sum() / np.pi) * sp)
    return out


def _at(line, zmm, sp):
    """Mittelpunkt und Radius der Mittellinie auf Höhe zmm (nächste vorhandene Schicht)."""
    zs = np.array(sorted(line))
    z = zs[np.argmin(np.abs(zs * sp - zmm))]
    return line[z]


def _pts(mask, sp):
    return np.argwhere(mask) * sp


def abdomen(cls, sub, sp):
    """Äste im Bauch. Rückgabe {'artery': [Mesh], 'vein': [Mesh]}; fehlt eine Landmarke, entfällt der Ast."""
    art, ven = [], []
    blood = cls == BLOOD
    zmax = cls.shape[2] * sp
    ao, ivc = _line(blood & (sub == 1), sp), _line(blood & (sub == 2), sp)
    if len(ao) < 20 or len(ivc) < 20:
        return {'artery': art, 'vein': ven}
    ao_z = np.array(sorted(ao)) * sp
    xmid = ao[sorted(ao)[len(ao) // 2]][0][0]
    sinus = _pts(np.isin(cls, [SINUS]), sp)
    kid = _pts(cls == KIDNEY, sp)
    hil = {}
    for side, sel in (('R', lambda p: p[:, 0] > xmid), ('L', lambda p: p[:, 0] <= xmid)):
        s = sinus[sel(sinus)] if len(sinus) else np.zeros((0, 3))
        k = kid[sel(kid)]
        if len(k) < 500 or k[:, 2].min() < sp * 3:
            continue   # Niere angeschnitten oder fehlt
        # Hilus: auf mittlerer Höhe des Nierenbeckens dessen medialer Rand
        src = s if len(s) > 100 else k
        zh = np.median(src[:, 2])
        sl = src[np.abs(src[:, 2] - zh) < 8]
        d = np.abs(sl[:, 0] - xmid)
        hil[side] = sl[d < np.percentile(d, 25)].mean(0)
    portal = _pts(blood & (sub == 3), sp)
    z_ren = np.mean([h[2] for h in hil.values()]) if hil else None
    # Höhenbezug: Zusammenfluss V. lienalis / Pfortader hinter dem Pankreashals (Höhe L1). Die AMS entspringt knapp
    # darunter hinter dem Pankreas, der Truncus coeliacus 1–2 cm darüber, die Nierenarterien 1–2 cm unter der AMS.
    z_conf = None
    if len(portal):
        ax = ao[sorted(ao)[len(ao) // 2]][0][0]
        near = portal[np.abs(portal[:, 0] - (ax + 15)) < 10]
        if len(near) > 20:
            z_conf = np.median(near[:, 2])
    if z_ren is not None and z_conf is not None and z_conf + 25 < ao_z.max() and z_conf - 30 > ao_z.min():
        z_ams, z_tc = z_conf - 6, z_conf + 12
        z_ren = min(z_ams - 14, max(z_ren, z_ams - 30))   # Abgang der Nierenarterien, die Gefäße fallen zum Hilus ab
        c_ren, r_ao = _at(ao, z_ren, sp)
        c_ams, r_ams0 = _at(ao, z_ams, sp)
        c_tc, _ = _at(ao, z_tc, sp)
        Y, X, Z = np.array([0, 1.0, 0]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0])
        # Truncus coeliacus und Dreiteilung
        tc0 = c_tc + Y * (r_ao * 0.3)
        tc1 = c_tc + Y * (r_ao + 15) + Z * 2
        art.append(tube([tc0, c_tc + Y * (r_ao + 8), tc1], 3.6, 3.2))
        if len(portal):
            # Leberpforte: oberes rechtes Ende der Pfortader
            pr = portal[portal[:, 0] > np.percentile(portal[:, 0], 85)].mean(0)
            art.append(tube([tc1, tc1 + X * 15 + Z * 3, (tc1 + pr) / 2 + Y * 6 + Z * 6, pr + Y * 8 + Z * 8], 2.6, 2.0))
        spl = _pts(cls == SPLEEN, sp)
        if len(spl) > 500 and len(portal):
            sv = portal[portal[:, 0] < np.percentile(portal[:, 0], 4)].mean(0)   # Ende der V. lienalis am Milzhilus
            sh = sv + Z * 9 + Y * 4
            mid = (tc1 + sh) / 2
            wig = [tc1 - X * 12 + Z * 4, mid + X * 12 + Y * 6 + Z * 10, mid - X * 8 - Y * 4 + Z * 4, sh + X * 12 + Z * 4, sh + X * 3]
            art.append(tube([tc1] + wig, 2.6, 2.2))
        art.append(tube([tc1, tc1 - X * 8 + Z * 10 + Y * 2, tc1 - X * 16 + Z * 24 + Y * 6], 1.6, 1.3))
        # A. mesenterica superior: erst nach vorn, dann nach kaudal, leicht nach rechts
        a0 = c_ams + Y * (r_ams0 * 0.3)
        sma = [a0, c_ams + Y * (r_ams0 + 10) - Z * 3, c_ams + Y * (r_ams0 + 20) - Z * 18,
               c_ams + Y * (r_ams0 + 28) - Z * 50 + X * 6, c_ams + Y * (r_ams0 + 32) - Z * 95 + X * 14]
        if sma[-1][2] > sp * 4:
            art.append(tube(sma, 3.6, 2.4))
        # Aa. renales
        for side, h in hil.items():
            sx = 1 if side == 'R' else -1
            r0 = c_ren + X * sx * r_ao * 0.3
            if side == 'R':
                cv, rv = _at(ivc, z_ren, sp)
                via = [cv[0] + 2, cv[1] - rv - 5, z_ren]   # hinter der V. cava
                art.append(tube([r0, c_ren + X * (r_ao + 5) - Y * 4, via, (np.array(via) + h) / 2 - Y * 2, h + X * 0], 2.8, 2.4))
            else:
                art.append(tube([r0, c_ren - X * (r_ao + 6) - Y * 2, (c_ren + h) / 2 - Y * 3, h], 2.8, 2.4))
        # Vv. renales
        for side, h in hil.items():
            cv, rv = _at(ivc, z_ren - 2, sp)
            if side == 'R':
                ven.append(tube([cv, cv + X * (rv + 6) - Y * 3, (cv + h) / 2 - Y * 2 - Z * 2, h - Z * 4], 5.0, 4.5))
            else:
                # vor der Aorta, hinter der AMS, unterhalb des AMS-Abgangs
                ca, ra = _at(ao, z_ren, sp)
                front = ca + Y * (ra + 5.5)
                ven.append(tube([cv, cv - X * (rv + 4) + Y * 2, front + X * 8, front - X * 10,
                                 ca - X * (ra + 14) + Y * 2, (ca + h) / 2 - X * 6 - Y * 2, h - Z * 4], 5.0, 5.5))
    # A. mesenterica inferior: 3–4 cm oberhalb der Bifurkation links vorn
    zb = ao_z.min()
    if zb + 45 < ao_z.max():
        c, r = _at(ao, zb + 38, sp)
        X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
        ima = [c + Y * r * 0.3 - X * r * 0.3, c + Y * (r + 4) - X * (r + 3) - Z * 4, c + Y * (r + 8) - X * (r + 18) - Z * 25,
               c + Y * (r + 10) - X * (r + 30) - Z * 55]
        if ima[-1][2] > sp * 4:
            art.append(tube(ima, 2.0, 1.4))
    # Vv. hepaticae: knapp unter der Zwerchfellkuppel von vorn in die V. cava
    liv = cls == LIVER
    if liv.any():
        zl = np.argwhere(liv)[:, 2].max() * sp
        zt = zl - 22
        if zt < max(ivc) * sp and zl < zmax - 3 * sp:
            cv, rv = _at(ivc, zt, sp)
            X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
            for d, ln, r in (((0.85, 0.35, -0.25), 75, 5.5), ((0.05, 0.95, -0.3), 65, 5.0), ((-0.75, 0.6, -0.2), 60, 4.5)):
                d = np.array(d) / np.linalg.norm(d)
                ven.append(tube([cv, cv + d * (rv + 8) + Z * 2, cv + d * (rv + ln * 0.55), cv + d * (rv + ln) - Z * 8], r, r * 0.5))
    # A. und V. iliaca interna
    for s, lst, r0, r1, back in ((6, art, 3.6, 2.6, 0), (7, ven, 5.0, 3.6, 8)):
        il = blood & (sub == s)
        if il.sum() < 200:
            continue
        for side in (1, -1):
            p = _pts(il & ((np.arange(il.shape[0])[:, None, None] * sp - xmid) * side > 8), sp)
            if len(p) < 100:
                continue
            ztop = p[:, 2].max()
            cen = []
            for z in np.unique(p[:, 2]):
                if ztop - 90 < z < ztop - 20:
                    q = p[p[:, 2] == z]
                    cen.append(q.mean(0))
            if not cen or ztop - 140 < sp * 4:
                continue
            cen = np.array(cen)
            o = cen[np.argmin(cen[:, 1])]   # hinterster Punkt: Teilung in A./V. iliaca externa und interna
            X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
            med = -side * X
            lst.append(tube([o, o - Y * (6 + back) - Z * 6 + med * 2, o - Y * (16 + back) - Z * 24 + med * 6,
                             o - Y * (20 + back) - Z * 46 + med * 10], r0, r1))
    return {'artery': art, 'vein': ven}


def thorax(cls, sub, sp):
    """Truncus pulmonalis mit A. pulmonalis dextra und sinistra (sauerstoffarm, im Lehrbuch blau)."""
    out = []
    blood, heart = cls == BLOOD, cls == HEART
    rv = _pts(heart & (sub == 9), sp)
    ao = blood & (sub == 1)
    pv = _pts(blood & (sub == 5), sp)
    if len(rv) < 1000 or ao.sum() < 1000 or len(pv) < 500:
        return out
    # Aortenbogen: unterste Höhe, auf der Aorta ascendens und descendens verbunden sind
    zs = [z for z in range(ao.shape[2]) if ao[:, :, z].sum() > 20]
    n2 = [z for z in zs if ndi.label(ao[:, :, z])[1] >= 2]
    if not n2:
        return out
    z_arch = max(n2) * sp
    asc = []
    for z in range(int((z_arch - 30) / sp), int(z_arch / sp)):
        lbl, n = ndi.label(ao[:, :, z])
        if n < 2:
            continue
        cs = [np.argwhere(lbl == i).mean(0) * sp for i in range(1, n + 1)]
        asc.append(max(cs, key=lambda c: c[1]))   # vordere = ascendens
    if not asc:
        return out
    asc = np.mean(asc, 0)
    top = rv[rv[:, 2] > rv[:, 2].max() - 12].mean(0)          # Ausflusstrakt
    xm = (pv[:, 0].min() + pv[:, 0].max()) / 2
    hr = pv[pv[:, 0] > xm].mean(0)
    hl = pv[pv[:, 0] <= xm].mean(0)
    X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
    b = np.array([asc[0] - 32, asc[1] - 30, z_arch - 24])     # Teilung links hinter der Aorta ascendens, unter dem Bogen
    trunk = [top - Z * 10, top + Z * 2, np.array([b[0] - 2, (top[1] + b[1]) / 2 + 8, (top[2] + b[2]) / 2 + 4]), b]
    out.append(tube(trunk, 12.0, 11.0))
    rpa = [b, np.array([asc[0], asc[1] - 38, b[2] - 2]), np.array([(asc[0] + hr[0]) / 2 + 10, hr[1] + 2, b[2] - 6]),
           np.array([hr[0] + 6, hr[1] + 2, hr[2] + 18])]
    out.append(tube(rpa, 9.0, 7.0))
    lpa = [b, np.array([b[0] - 14, b[1] - 12, b[2] + 1]), np.array([hl[0] - 6, hl[1] - 4, hl[2] + 16]),
           np.array([hl[0] - 18, hl[1], hl[2] + 8])]
    out.append(tube(lpa, 9.0, 7.0))
    return out


def ergaenzen(cls, sub, sp):
    """Alle schematischen Äste, die in dieses Volumen passen."""
    a = abdomen(cls, sub, sp)
    return {'astart': a['artery'], 'astvene': a['vein'], 'pulmart': thorax(cls, sub, sp)}
