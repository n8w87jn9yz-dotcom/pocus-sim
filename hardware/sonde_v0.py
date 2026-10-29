"""Sondengehäuse v0 und Kalibrierbock für die Quest-Version (xr.html), Druck auf Bambu P1S (PETG, 0,4-mm-Düse).

Sonde: Konvex-Attrappe mit gewölbter Schallfläche (Radius 40 mm wie im Shader), Griff und oben ein Sattel,
auf den der Touch-Controller mit dem Griffende gesetzt und mit einem 25-mm-Klettband festgezurrt wird.
Die genaue Lage des Controllers muss nicht stimmen: xr.html misst Spitze und Achsen selbst ein.
Mitte der Schallfläche: kleine Kegelbohrung für den Kalibrierbock. Markerseite: Rippe an der linken Schmalseite.

    python hardware/sonde_v0.py   # schreibt hardware/sonde_v0.stl und hardware/kalibrierbock_v0.stl

Koordinaten in mm: z = Sondenlängsachse (Schallfläche bei z = 0, Griff nach +z), x = lateral, y = Elevation.
"""
from pathlib import Path

import manifold3d as m3
import numpy as np
import trimesh

OUT = Path(__file__).resolve().parent
SEG = 96

# Schallkopf
FACE_W, FACE_T, FACE_R = 52.0, 20.0, 40.0   # Breite, Dicke (Elevation), Wölbungsradius
HEAD_H = 24.0
# Griff
GRIP_W, GRIP_T, GRIP_Z = 36.0, 27.0, 118.0
# Sattel für den Controller (❓ an Simons Controller anpassen: Griffende innen ca. 40 x 34 mm)
CUP_W, CUP_T, CUP_D, WALL = 42.0, 36.0, 10.0, 3.0
STRAP_W, STRAP_GAP = 27.0, 4.0              # Schlitze für 25-mm-Klettband
# Kalibrierung
HOLE_R, HOLE_D = 2.0, 4.0                   # Kegelbohrung in der Schallfläche
PIN_R, PIN_H = 3.0, 6.0                     # Kegel am Bock (gleicher Öffnungswinkel wie die Bohrung)


def rrect(w, t, r):
    """Abgerundetes Rechteck als Querschnitt, zentriert."""
    r = min(r, w / 2 - 0.01, t / 2 - 0.01)
    return m3.CrossSection.square((w - 2 * r, t - 2 * r), center=True).offset(r, m3.JoinType.Round, circular_segments=SEG)


def slab(cs, z, h=0.01):
    return cs.extrude(h).translate((0, 0, z))


def probe():
    # Kopf und Griff als Hülle über Querschnitte: weicher Übergang wie bei echten Konvexsonden
    sections = [(rrect(FACE_W, FACE_T, 6), 0), (rrect(FACE_W, FACE_T, 6), HEAD_H),
                (rrect(GRIP_W + 4, GRIP_T, 9), HEAD_H + 22), (rrect(GRIP_W, GRIP_T - 2, 10), 70),
                (rrect(GRIP_W + 2, GRIP_T, 10), GRIP_Z)]
    body = m3.Manifold.batch_hull([slab(cs, z) for cs, z in sections])
    # gewölbte Schallfläche: Zylinder (Achse = Elevation y) schneidet den Kopf unten rund
    cyl = m3.Manifold.cylinder(FACE_T + 10, FACE_R, circular_segments=4 * SEG, center=True).rotate((90, 0, 0)).translate((0, 0, FACE_R))
    lower = m3.Manifold.cube((FACE_W + 10, FACE_T + 10, FACE_R), center=True).translate((0, 0, FACE_R / 2))
    body = (body - lower) + (body ^ cyl ^ lower)
    # Kegelbohrung in der Mitte der Schallfläche (Spitze nach innen)
    cone = m3.Manifold.cylinder(HOLE_D, HOLE_R, 0.0, circular_segments=SEG).translate((0, 0, -0.01))
    body = body - cone
    # Markerrippe an der linken Schmalseite (-x), wie die Kerbe an echten Sonden
    rib = m3.Manifold.cube((2.4, 6, 12), center=True).translate((-FACE_W / 2 - 0.6, 0, HEAD_H / 2 + 2))
    body = body + rib
    # Sattel oben: Wanne fürs Griffende des Controllers mit zwei Schlitzen für das Klettband
    ow, ot = CUP_W + 2 * WALL, CUP_T + 2 * WALL
    cup = rrect(ow, ot, 8).extrude(CUP_D + WALL).translate((0, 0, GRIP_Z - 0.5))
    pocket = rrect(CUP_W, CUP_T, 6).extrude(CUP_D + 1).translate((0, 0, GRIP_Z + WALL - 0.5))
    slots = [m3.Manifold.cube((STRAP_GAP, STRAP_W, CUP_D + 2 * WALL + 2), center=True)
             .translate((s * (ow / 2 + STRAP_GAP / 2 - 0.2), 0, GRIP_Z + (CUP_D + WALL) / 2)) for s in (-1, 1)]
    ears = [rrect(STRAP_GAP + 2 * 2.5, STRAP_W + 2 * 2.5, 2).extrude(CUP_D + WALL)
            .translate((s * (ow / 2 + STRAP_GAP / 2 - 0.2), 0, GRIP_Z - 0.5)) for s in (-1, 1)]
    top = cup + ears[0] + ears[1] - pocket - slots[0] - slots[1]
    return body + top


def block():
    base = rrect(70, 70, 8).extrude(12)
    pin = m3.Manifold.cylinder(PIN_H, PIN_R, 0.0, circular_segments=SEG).translate((0, 0, 12))
    # Griffmulden, damit der Bock mit der freien Hand festgehalten werden kann
    grip = [m3.Manifold.cylinder(80, 6, circular_segments=SEG).rotate((90, 0, 0)).translate((s * 35, 40, 9)) for s in (-1, 1)]
    return base + pin - grip[0] - grip[1]


def save(man, name):
    mesh = man.to_mesh()
    tm = trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=True)
    assert tm.is_watertight, name
    tm.export(OUT / f'{name}.stl')
    b = tm.bounds
    print(f'{name}.stl: {(b[1] - b[0]).round(1).tolist()} mm, {tm.volume / 1000:.0f} cm³')


if __name__ == '__main__':
    save(probe(), 'sonde_v0')
    save(block(), 'kalibrierbock_v0')
