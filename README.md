# pocus-sim

Trainingssimulator für Notfallsonografie (POCUS). Der Laptop zeigt das Ultraschallbild, das Handy ist der Schallkopf.
Das Bild wird aus echten CT-Daten berechnet: Organe aus der CT-Segmentierung bekommen Echogenität und Dämpfung,
der Schallstrahl erzeugt Schallschatten hinter Knochen, A-Linien hinter der Pleura und ein Spiegelbild über dem Zwerchfell.

Reine statische Web-App ohne Build-Schritt.

## Inhalt
- `index.html`: Monitor am Laptop: Bild, Anatomieansicht, QR-Kopplung, Fensterwahl, Schallkopf, Befunde, Webcam, NFC-Adressen
- `probe.html`: Schallkopf am Handy: nur Sonde (Antippen wechselt den Typ) und „Kalibrieren“, liest NFC-Tags
- `js/shader.js`: Bilderzeugung aus dem CT-Volumen (WebGL2), Anatomieansicht, Einfärbung der Organe
- `js/webcam.js`: altes Webcam-Tracking des Markers hinten am Handy (js-aruco2)
- `print.html`: Druckvorlage für den Handy-Marker
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
2. QR-Code mit dem Handy scannen (iPhone oder Android).
3. Handy hochkant halten: Unterkante = Schallkopffläche, Bildschirm zu dir, linke Kante = Marker.
4. Fenster am Laptop wählen, Sonde in Standardlage aufsetzen (Phantom, Partner oder in der Luft) und am Handy „Kalibrieren“ tippen.
   Der erste Tipp startet die Sensoren, das iPhone fragt dabei nach Erlaubnis.

### Verschieben mit der Maus-Sonde
1. Eine Funkmaus (optisch oder Laser, am Laptop verbunden) mit Gummiband oder Klett unter die Unterkante des Handys binden.
   Maus vorn zeigt von dir weg, also in Richtung Handyrückseite. Sitzt sie anders, am Laptop bei „Maus“ die Drehung wählen.
2. Am Laptop „Maus-Sonde starten“ (oder Taste M). Der Mauszeiger verschwindet, Esc beendet. Den Trackpad dabei nicht berühren.
3. Sonde am Fenster ansetzen und am Handy „Kalibrieren“. Ab dann folgt das Schnittbild dem Gleiten über Shirt, Handtuch oder Phantom.
4. Einmal einmessen: Taste E (oder Mausklick), Sonde genau 10 cm am Lineal entlang schieben, nochmal E. Der Maßstab bleibt gespeichert.
5. „Größe“ gleicht Puppe oder Partner an den CT-Körper an.

Die Maus misst das Gleiten in ihrer eigenen Richtung, das Gyro dreht es in die Körperrichtung. Kippt man die Sonde stark,
hebt die Maus ab und meldet nichts, die Position bleibt dann stehen. Chrome liefert rohe Mauspunkte ohne Zeigerbeschleunigung,
Safari nur die beschleunigte Zeigerbewegung, dort ist der Weg bei schnellem Schieben zu lang.

**Ohne Maus:** Im Wischfeld am Handy wischen wie auf einem Touchpad: seitlich = entlang der Sonde, nach unten = zu dir hin.

### Verschieben mit der Webcam (alt)
Unter „Webcam (alt)“: `print.html` mit 100 % drucken, Marker hinten unten aufs Handy kleben, Laptop so stellen, dass die Webcam
die Handyrückseite sieht. Funktioniert praktisch nur, wenn das Handy aufrecht steht, also eher an der Lunge.

### Anatomie und Einfärbung
„Anatomie im Schnitt“ zeigt rechts neben dem Bild dieselbe Schnittebene in Gewebefarben mit Beschriftung,
„Sondenposition“ den Körper von vorn mit der Sonde. „Organe einfärben“ tönt Organe im Ultraschallbild leicht und beschriftet sie.

### NFC-Tags
Unter „NFC-Tags“ am Laptop stehen Adressen (`probe.html?s=haemo`, `probe.html?w=ruq` …). Mit einer NFC-App als URL auf Tags schreiben.
Fall-Tags laden den Fall verdeckt, Fenster-Tags wählen das Schallfenster. Android (Chrome) liest Tags direkt in der geöffneten Seite,
das iPhone öffnet die Adresse in einem neuen Tab, verbindet sich mit dem gespeicherten Code neu und braucht danach einmal „Kalibrieren“.

Ohne Handy: lokal `python3 -m http.server` im Repo und `http://localhost:8000` öffnen.
Maus ziehen = Kippen/Fächern, Umschalttaste + ziehen = Drehen, Mausrad = Tiefe, Pfeiltasten = Verschieben, 1–6 = Fenster, A = Anatomieansicht, T = Einfärben.
`?h=300` rendert mit geringerer Auflösung, `?debug` zeigt die Gewebeklassen farbig.

## Volumen neu bauen
```
pip install TotalSegmentator
TotalSegmentator -i ct.nii.gz -o seg.nii.gz --ml
python tools/build_volume.py --ct ct.nii.gz --seg seg.nii.gz --name thorax --windows subxiphoid,lung_r,lung_l
```

## Grenzen
- Das Gyro misst nur die Ausrichtung. Die Position kommt aus dem Kalibrieren am Fenster plus Maus-Sonde, Wischen oder Pfeiltasten. Die Maus driftet nur wenig, nach längerem Schallen hilft trotzdem neu kalibrieren.
- Webcam-Tracking: in der Bildebene der Webcam grob 0,5 cm genau, auf die Webcam zu oder von ihr weg ungenauer (1–2 cm).
  Der Marker muss im Bild bleiben, sonst bleibt die Position stehen. Noch nicht mit echtem Gerät getestet.
- Die Herzkammern sind im nativen CT nicht sichtbar. Ihre Wände werden aus der echten Herzkontur abgeleitet.
- Freie Flüssigkeit und Perikarderguss sind in die echte Anatomie eingerechnet, nicht aus Patientendaten.
- Auflösung 1,5 mm (Thorax) bzw. 3 mm Ursprungsdaten (Abdomen). Medizinisch nicht validiert.
- Die Kopplung nutzt den öffentlichen PeerJS-Server (0.peerjs.com).
