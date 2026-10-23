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
