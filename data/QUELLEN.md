# Datenquellen

## thorax (subxiphoidal, Lunge) und abdomen (RUQ, LUQ, Becken)
- CT und Segmentierung: TotalSegmentator-Datensatz v2.0.1, Fall s0662.
  Wasserthal J. et al., „TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images“,
  Radiology: Artificial Intelligence 2023. Datensatz: Zenodo, https://doi.org/10.5281/zenodo.10047292.
- Lizenz: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
- Änderungen: Volumen zugeschnitten (Thorax- und Abdomenausschnitt), neu abgetastet (Thorax 1,5 mm, Abdomen 1,75 mm),
  Segmentierungen zu Gewebeklassen zusammengefasst; umgerechnet mit `tools/build_volume.py`.

## 3D-Modelle (anatomy.glb)
Oberflächen aus den Gewebeklassen von `vol.bin.gz`, berechnet mit `tools/build_meshes.py` (Marching Cubes, geglättet).
Arterien und Venen werden nach den Strukturen der Segmentierung getrennt (Aorta, Aa. iliacae, supraaortale Arterien bzw. Vv. cavae, V. portae/lienalis, Lungenvenen, Vv. iliacae, Vv. brachiocephalicae); Stand 27.10.2026.
Nicht im CT-Fall enthaltene Hauptäste sind in der 3D-Ansicht **schematisch ergänzt** (`tools/gefaesse_schema.py`, Lehrbuchlage, an Landmarken desselben Falls verankert; Lage und Kaliber nur zur Orientierung): Truncus coeliacus mit A. hepatica communis, A. lienalis und A. gastrica sinistra, A. mesenterica superior und inferior, Aa. und Vv. renales, Vv. hepaticae, A. und V. iliaca interna, Truncus pulmonalis mit Aa. pulmonales. Sie erscheinen nicht im Ultraschallbild. Lungenarterien sind wie im Atlas blau, Lungenvenen rot dargestellt.
Abgeleitet aus Fall s0662 des TotalSegmentator-Datensatzes, daher ebenfalls CC BY 4.0 (Quelle wie oben).

## Echte Vergleichsbilder (Taste R)
Nicht im Paket enthalten: Die Clips werden direkt von Wikimedia Commons geladen. Urheber, Lizenz (CC BY 2.0,
CC BY-SA 3.0) und Link stehen in `js/reference.js` und werden unter jedem Clip angezeigt. Im Simulator nur
grau gefiltert und am Rand beschnitten (Geräte- und Textfelder), sonst unverändert.
