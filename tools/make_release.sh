#!/bin/sh
# Baut ein ZIP mit allen Dateien, die der Simulator im Browser braucht (ohne Werkzeuge und Doku).
# Alle Pfade sind relativ, das ZIP läuft daher auch in einem Unterordner wie /lernwelt/pocus/.
# Aufruf: tools/make_release.sh [Zieldatei.zip]
set -e
cd "$(dirname "$0")/.."
out="${1:-pocus-sim.zip}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
rm -f "$out"
zip -qr "$out" index.html probe.html print.html css js vendor data -x 'data/QUELLEN.md'
zip -qj "$out" data/QUELLEN.md vendor/THIRD_PARTY.txt
echo "$out ($(du -h "$out" | cut -f1))"
