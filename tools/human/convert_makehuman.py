"""MakeHuman-Grundmodell (CC0) -> tools/human/body.bin für die Halte-Bilder.

Nur die Gruppe "body" (ohne Hilfsgeometrie), Dreiecke, Achsen ins CT-System gedreht:
x = rechts des Menschen, y = vorn, z = oben. Einheit wie im Original (dm), skaliert wird beim Rendern.
Aufbau body.bin: uint32 nV, uint32 nI, float32[3*nV], uint32[nI].
Aufruf: python3 tools/human/convert_makehuman.py base.obj tools/human/body.bin
"""
import struct
import sys

src, dst = sys.argv[1], sys.argv[2]
verts, faces, group = [], [], None
for line in open(src):
    if line.startswith('v '):
        x, y, z = map(float, line.split()[1:4])
        verts.append((-x, z, y))   # Blick des Menschen +z -> y, oben +y -> z, seine rechte Seite ist -x
    elif line.startswith('g '):
        group = line.split()[1]
    elif line.startswith('f ') and group == 'body':
        idx = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
        for i in range(1, len(idx) - 1):
            faces.append((idx[0], idx[i], idx[i + 1]))
used = sorted({i for f in faces for i in f})
remap = {o: n for n, o in enumerate(used)}
pos = [c for i in used for c in verts[i]]
ind = [remap[i] for f in faces for i in f]
with open(dst, 'wb') as fh:
    fh.write(struct.pack('<II', len(used), len(ind)))
    fh.write(struct.pack(f'<{len(pos)}f', *pos))
    fh.write(struct.pack(f'<{len(ind)}I', *ind))
print(len(used), 'Punkte', len(ind) // 3, 'Dreiecke')
