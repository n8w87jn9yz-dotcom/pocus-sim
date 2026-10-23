# pocus-sim

Trainingssimulator für Notfallsonografie (POCUS). Der Laptop zeigt das Ultraschallbild, das Handy ist der Schallkopf.
Das Bild wird aus echten CT-Daten berechnet: Organe aus der CT-Segmentierung bekommen Echogenität und Dämpfung,
der Schallstrahl erzeugt Schallschatten hinter Knochen, A-Linien hinter der Pleura und ein Spiegelbild über dem Zwerchfell.

Reine statische Web-App ohne Build-Schritt.

## Inhalt
- `index.html`: Monitor am Laptop: Bild, QR-Kopplung, Fensterwahl, Schallkopf, Befunde
- `probe.html`: Schallkopf am Handy: Schallkopfwahl, Gyro, Ansetzen am Fenster, Tiefe/Gain, Freeze, Wisch-Pad
- `js/shader.js`: Bilderzeugung aus dem CT-Volumen (WebGL2)
- `js/common.js`: Schallköpfe, Fenster, Befunde, Rotationsmathematik
- `tools/build_volume.py`: wandelt CT + Segmentierung in `data/<name>/` um
- `data/`: fertige Volumen, siehe [data/QUELLEN.md](data/QUELLEN.md)
- `docs/architektur.md`: Architektur und Entscheidungen

## Umfang
Fenster: RUQ, LUQ, subxiphoidal, Becken, Lunge rechts/links (eFAST).
Befunde: freie Flüssigkeit (Morison, LUQ, Becken), Perikarderguss, Pneumothorax (kein Lungengleiten).
Schallköpfe: Linear 7,5 MHz, Konvex 3,5 MHz, Sektor 2,5 MHz.

## Starten
Das Handy braucht **HTTPS**, sonst liefert der Browser keine Sensordaten. Am einfachsten über GitHub Pages
(Settings → Pages → Branch `main`, Ordner `/ (root)`).

1. Am Laptop die Pages-Adresse öffnen.
2. QR-Code mit dem Handy scannen (iPhone oder Android), „Sensoren starten“ tippen. Das iPhone fragt nach Erlaubnis.
3. Handy hochkant halten: Unterkante = Schallkopffläche, Bildschirm zu dir, linke Kante = Marker.
4. Sonde in Standardlage auf das Fenster setzen (Phantom, Partner oder in der Luft) und unter „Ansetzen“ das Fenster tippen.

Ohne Handy: lokal `python3 -m http.server` im Repo und `http://localhost:8000` öffnen.
Maus ziehen = Kippen/Fächern, Umschalttaste + ziehen = Drehen, Mausrad = Tiefe, Pfeiltasten = Verschieben, 1–6 = Fenster.
`?h=300` rendert mit geringerer Auflösung, `?debug` zeigt die Gewebeklassen farbig.

## Volumen neu bauen
```
pip install TotalSegmentator
TotalSegmentator -i ct.nii.gz -o seg.nii.gz --ml
python tools/build_volume.py --ct ct.nii.gz --seg seg.nii.gz --name thorax --windows subxiphoid,lung_r,lung_l
```

## Grenzen
- Das Gyro misst nur die Ausrichtung. Die Position kommt aus dem Ansetzen am Fenster plus Wisch-Pad.
- Die Herzkammern sind im nativen CT nicht sichtbar. Ihre Wände werden aus der echten Herzkontur abgeleitet.
- Freie Flüssigkeit und Perikarderguss sind in die echte Anatomie eingerechnet, nicht aus Patientendaten.
- Auflösung 1,5 mm (Thorax) bzw. 3 mm Ursprungsdaten (Abdomen). Medizinisch nicht validiert.
- Die Kopplung nutzt den öffentlichen PeerJS-Server (0.peerjs.com).
