---
typ: entscheidung
bereich: [szenarioheld]
tags: [projekt/pocus-simulator, architektur, entscheidung]
beschreibung: Architektur und Machbarkeit des POCUS-Simulators mit Handy als Schallkopf und Laptop als Monitor.
erstellt: 2026-10-23
bearbeitet_von: claude
---


# POCUS-Simulator – Architektur 2026-10-23

Vorschlag von Claude (23.10.2026), technische Einschätzungen ❓ ungeprüft, bis sie im Prototyp bestätigt sind. Projekt: [[POCUS-Simulator – Projektübersicht]].

## Ziel
Ein Trainingssimulator für Notfallsonografie (POCUS). Am Laptop/PC zeigt eine Website das simulierte Ultraschallbild. Das Handy ist der Schallkopf: Dort wählt man den Schallkopftyp und bewegt es wie eine Sonde, die Sensoren liefern die Ausrichtung.

## Architektur (Vorschlag)

**Alles als Web-App, keine Installation.**

| Teil | Aufgabe | Technik |
|---|---|---|
| Laptop („Monitor“) | Zeigt QR-Code zum Koppeln, rendert das US-Bild, Bedienleiste (Tiefe, Gain, Freeze, Fall-Auswahl) | TypeScript + Vite, WebGL2-Shader fürs Bild |
| Handy („Schallkopf“) | Schallkopfwahl (Linear, Konvex, Sektor/Phased), sendet Orientierung mit ca. 60 Hz, Touch für kleines Verschieben, Tasten für Tiefe/Gain | Gleiche Web-App, Route `/probe`, `DeviceOrientation`/`Gyroscope` → Quaternion |
| Kopplung | Handy scannt QR-Code mit Sitzungs-ID, danach direkte Verbindung | WebRTC-DataChannel über PeerJS (öffentlicher Signalisierungsserver), Fallback WebSocket-Relay |
| Hosting | Statisch, HTTPS (Pflicht für Sensoren auf iOS) | GitHub Pages |

Latenz über WebRTC im selben WLAN: typischerweise unter 30 ms, also flüssig genug.

Stolpersteine: iOS verlangt HTTPS und einen Tipp auf „Sensoren erlauben“ (`DeviceOrientationEvent.requestPermission`). Der Bildschirm des Handys muss wach bleiben (Wake Lock API).

## Das Kernproblem: Position

Das Gyroskop liefert nur die **Ausrichtung** (Kippen, Drehen, Fächern), keine **Position** auf dem Körper. Position aus dem Beschleunigungssensor zu integrieren driftet schon nach Sekunden um Zentimeter bis Dezimeter. Das ist unbrauchbar.

Optionen:

1. **Gyro + Schallfenster-Auswahl. ✅ Entschieden für Phase 1 (Simon, 23.10.2026).** Man wählt das Fenster (z. B. RUQ/Morison, LUQ, subxiphoidal, suprapubisch, Lunge links/rechts) per Tipp auf einer Körperskizze. Innerhalb des Fensters steuert das Gyro Kippen, Rotation und Fächern, ein Wisch auf dem Handy verschiebt die Sonde um wenige Zentimeter. Robust, sofort machbar. Für POCUS sehr passend, weil das Lernziel vor allem „richtiges Fenster finden und dann richtig fächern/kippen“ ist.
2. **AR mit der Laptop-Webcam (Phase 2).** Die Webcam filmt das Handy, auf dessen Rückseite ein ArUco-Marker klebt (oder ein Marker auf dem Display). Ergebnis: echte 6-DoF-Position relativ zu einem Phantom/Partner oder einer Torso-Matte. Läuft im Browser (OpenCV.js oder js-aruco), Gyro glättet die Drehung.
3. **AR mit der Handy-Kamera.** Unpraktisch, weil die Rückkamera beim Aufsetzen direkt auf dem Körper liegt und nichts sieht. WebXR mit 6-DoF gibt es nur auf Android-Chrome, nicht in Safari auf dem iPhone.

## Bilderzeugung

| Ansatz | Realismus | Aufwand | Pathologien |
|---|---|---|---|
| **A: Simulation aus CT-Segmentierung** (offene Datensätze wie TotalSegmentator, CC-BY). Gewebelabels → akustische Eigenschaften, Strahlverfolgung pro Scanline im Shader: Reflexion an Grenzflächen, Dämpfung, Schallschatten hinter Knochen, Speckle, TGC | gut, anatomisch korrekt | mittel bis hoch | gut: Labels editieren (freie Flüssigkeit im Morison, Perikarderguss) |
| **B: Prozedural** (Organe als einfache 3D-Formen/SDFs, Artefakte per Regel) | mittel, „schematisch“ | niedrig | sehr gut steuerbar |
| **C: Echte Videoclips** nach Fenster und Winkel abgelegt | sehr hoch | hoch (Material, Rechte) | nur was gefilmt wurde |

**Empfehlung:** Mit B starten, damit die Kette Handy → Laptop → Bild schnell steht, und die gleiche Render-Pipeline später mit einem CT-Volumen (A) füttern. Lunge ist ein Sonderfall: Pleuralinie, A-Linien, B-Linien, Lungengleiten sind fast reine Artefakte und lassen sich prozedural sehr realistisch erzeugen.

## Welche Protokolle zuerst
1. **eFAST**: RUQ, LUQ, subxiphoidal, suprapubisch, plus Lunge beidseits (Pneumothorax: fehlendes Lungengleiten, Lungenpunkt). Klar abgegrenzte Fenster, ideal für Option 1.
2. Danach Fokus-Echo/RUSH (parasternal lang/kurz, apikal 4K, VCI), Aorta, Kompressions-Sono der Beinvenen.

Fälle pro Protokoll als Ein/Aus-Schalter am Laptop: „normal“, „freie Flüssigkeit Morison“, „Perikarderguss“, „Pneumothorax rechts“ usw.

## Phasenplan
1. **Kopplung + Gyro-Demo**: QR-Code, Handy dreht ein 3D-Sondenmodell am Laptop.
2. **Prozedurales eFAST** mit Fenster-Auswahl, Schallkopftypen, Tiefe/Gain.
3. **Fallsteuerung** (Pathologien, Trainer-Modus).
4. **CT-basiertes Volumen** für realistischere Anatomie.
5. **Webcam-AR** für echte Positionsbestimmung.

## Offene Entscheidungen
- Bildquelle: prozedural zuerst oder direkt CT-basiert?
- Wird auf einem echten Partner/Phantom geübt oder „in der Luft“?
- iPhone oder Android (wichtig für Sensor-Rechte und WebXR)?
- Repository: GitHub-Repo anlegen, damit Code und Hosting (Pages) dort liegen.
