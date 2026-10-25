# Datenquellen

## thorax (subxiphoidal, Lunge)
- CT: 3D Slicer SampleData „CTChest“ (`CT-chest.nrrd`), heruntergeladen von
  https://github.com/Slicer/SlicerTestingData/releases (SHA256 4507b664690840abb6cb9af2d919377ffc4ef75b167cb6fd0f747befdb12e38e).
- ❓ Lizenz der Originaldaten ungeklärt. 3D Slicer verteilt sie öffentlich als Beispieldaten, eine ausdrückliche Lizenz ist dort nicht angegeben.
- Segmentierung: TotalSegmentator 2 (Task `total`, 1,5 mm), Apache-2.0.

## abdomen (RUQ, LUQ, Becken)
- CT: `tests/reference_files/example_ct.nii.gz` aus https://github.com/wasserth/TotalSegmentator (Apache-2.0), 3 mm.
- Segmentierung: TotalSegmentator 2 (`--fast`).

Beide Volumen sind mit `tools/build_volume.py` umgerechnet. Für bessere Bildqualität eignet sich ein Fall aus dem
TotalSegmentator-Datensatz (CC BY 4.0, https://doi.org/10.5281/zenodo.6802613).

## 3D-Modelle (anatomy.glb)
Oberflächen aus den Gewebeklassen von `vol.bin.gz`, berechnet mit `tools/build_meshes.py` (Marching Cubes, geglättet).
Gleiche Herkunft und Lizenz wie das jeweilige Volumen.

## Echte Vergleichsbilder (Taste R)
Nicht im Paket enthalten: Die Clips werden direkt von Wikimedia Commons geladen. Urheber, Lizenz (CC BY 2.0,
CC BY-SA 3.0) und Link stehen in `js/reference.js` und werden unter jedem Clip angezeigt. Im Simulator nur
grau gefiltert und am Rand beschnitten (Geräte- und Textfelder), sonst unverändert.
