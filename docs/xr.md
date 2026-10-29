# Quest-3-Version (xr.html), Phase 0

Mixed Reality an einer echten Laerdal Resus Anne: Ein Touch-Controller steckt im gedruckten Sondengehäuse,
die Brille liefert seine volle Lage (Position und Drehung). Das Ultraschallbild kommt aus demselben Shader und
denselben CT-Volumen wie der Monitor (`index.html`) und erscheint auf einem virtuellen Gerät neben der Puppe.
Ziel von Phase 0: prüfen, ob Tracking, Registrierung und Bildleistung auf der Quest reichen.

## Dateien
- `xr.html`, `js/xr.js`: WebXR-Seite (three.js, `immersive-ar` mit Passthrough), Ablauf und Bedienung
- `js/usrender.js`: Ultraschallbild in eigenem WebGL2-Kontext, wird als Textur aufs Gerät gelegt
- `js/xrmath.js`: Pivot-Kalibrierung, affine Registrierung, Polarzerlegung
- `tools/align_volumes.py`: legt Thorax und Abdomen (beide Fall s0662) in einen gemeinsamen Körperraum,
  schreibt `offset` in `data/thorax/meta.json` (Ergebnis 29.10.2026: [1,1; 1,0; 311,0] mm, 95 % Knochendeckung)
- `hardware/sonde_v0.py`: Sondengehäuse und Kalibrierbock als STL (`hardware/*.stl`)

## Ablauf
1. **Sonde einmessen** (einmal, in `localStorage` gespeichert):
   Pivot: Sondenloch auf den Kegel des Kalibrierbocks, Trigger halten, kreisen. Ergebnis: Spitze im Controllersystem.
   Tisch: Schallfläche flach auf den Tisch, Marker von dir weg, Trigger. Ergebnis: Sondenachsen im Controllersystem
   (Schallrichtung genau, Drehung um die Schallachse so genau wie die Blickrichtung).
2. **Puppe registrieren** (jede Sitzung): Sonde nacheinander auf die sechs eFAST-Fenster in Standardlage setzen.
   Die Hautpunkte dieser Fenster im CT (`meta.json` → Hautsuche) sind die Gegenpunkte; daraus eine affine Abbildung
   Welt (m) → CT (mm). Angezeigt werden Restfehler je Punkt und wie weit die Sonde von der Standardlage abwich.
3. **Schallen**: Spitze → CT-Punkt, Sondenachsen über den Drehanteil der Abbildung. Das Fenster (`uWin`) ist das
   nächstgelegene eFAST-Fenster, daraus folgen Volumen und fensterabhängige Effekte im Shader (Herzschlag, Pneumothorax).
   Hautkontakt: CT-Haut höchstens 8 mm hinter der Spitze, sonst bleibt das Bild schwarz.

## Simulation am Rechner
`xr.html?sim` (oder Knopf „Simulation am Rechner“): bekannte Puppe (CT-Körper um 8 % verkleinert), Registrierung mit
3 mm und 4° Zufallsfehler, danach fährt die Sonde alle Fenster ab. Stand 29.10.2026: Restfehler max. 3 mm, gemessener
Maßstab 1,08, RUQ-Bild deckungsgleich mit dem Monitor.

## Offen nach Phase 0
- ❓ Hält das Controller-Tracking dicht über der Puppe, wenn die Hand das Gehäuse umgreift?
- ❓ GPU-Zeit des Shaders auf der Quest (Anzeige im Gerät), ggf. `?h=240` oder Nachbarstrahlen abschalten
- Registrierung geht beim Neustart verloren (keine persistenten Anker), Sonden-Einmessung bleibt
- Doppelter Ladecode in `monitor.js` und `usrender.js`, später zusammenführen
- Beschriftung der Organe (`sampleLabels`) und Fallsteuerung vom Trainer-Laptop fehlen noch
