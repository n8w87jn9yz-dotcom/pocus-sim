# POCUS-Simulator (Prototyp Phase 1)

Laptop zeigt das simulierte Ultraschallbild, das Handy ist der Schallkopf.
Reine statische Web-App ohne Build-Schritt. PeerJS und qrcode-generator liegen in `vendor/` (beide MIT-Lizenz).

## Inhalt
- `index.html`: Monitor am Laptop: Bild, QR-Kopplung, Fensterwahl, Schallkopf, Fallsteuerung
- `probe.html`: Schallkopf am Handy: Schallkopfwahl, Gyro, Tiefe/Gain, Freeze, Wisch-Pad
- `js/shader.js`: Bilderzeugung (prozedurale Anatomie, Dämpfung, Schallschatten, A-Linien, Lungengleiten)
- `js/common.js`: Schallköpfe, Fenster, Befunde, Rotationsmathematik

## Umfang
Fenster: RUQ, LUQ, subxiphoidal, Becken, Lunge rechts/links (eFAST).
Befunde: freie Flüssigkeit (Morison, LUQ, Becken), Perikarderguss, Pneumothorax (fehlendes Lungengleiten).
Schallköpfe: Linear 7,5 MHz, Konvex 3,5 MHz, Sektor 2,5 MHz.

## Starten
Das Handy braucht **HTTPS**, sonst liefert der Browser keine Sensordaten. Am einfachsten über GitHub Pages:

1. Neues privates oder öffentliches Repo anlegen, Inhalt dieses Ordners hochladen.
2. Im Repo: Settings → Pages → Branch `main`, Ordner `/ (root)` → Save.
3. Am Laptop `https://<name>.github.io/<repo>/` öffnen.
4. QR-Code mit dem Handy scannen, „Sensoren starten“ tippen (iPhone fragt nach Erlaubnis).
5. Handy hochkant halten (Unterkante = Schallkopffläche, Bildschirm zu dir), „Neutralstellung“ tippen.

Nur Laptop, ohne Handy: lokal `python3 -m http.server` im Ordner und `http://localhost:8000` öffnen.
Maus ziehen = Kippen/Fächern, Umschalttaste + ziehen = Drehen, Mausrad = Tiefe, Pfeiltasten = Verschieben, 1–6 = Fenster.
Langsamer Rechner: `index.html?h=300` rendert mit geringerer Auflösung.

## Grenzen
- Das Gyro misst nur die Ausrichtung. Die Position kommt aus der Fensterwahl plus Wisch-Pad.
- Die Anatomie ist schematisch (Ellipsoide), nicht aus echten Bilddaten. Medizinisch nicht validiert.
- Die Kopplung nutzt den öffentlichen PeerJS-Server (0.peerjs.com). Fällt er aus, geht nur die Maussteuerung.
