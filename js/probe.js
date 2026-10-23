import { PROBES, WINDOWS, SCENARIOS, quatFromEuler } from './common.js';

const $ = id => document.getElementById(id);
let conn = null;
let wakeLock = null;
let peer = null;
let gotEvent = false;
let sensorsOn = false;
let probe = 'convex';

// NFC-Tag-Adresse (probe.html?s=… oder ?w=…), wird nach dem Verbinden an den Rechner geschickt
const params = new URLSearchParams(location.search);
let pendingTag = tagFrom(params);
if (pendingTag) { try { localStorage.setItem('pocus-nfc', '1'); } catch { /* kein Speicher */ } }

function tagFrom(p) {
  const s = p.get('s'), w = p.get('w');
  if (s && (s === 'random' || SCENARIOS.some(x => x.id === s))) return { t: 'tag', s };
  if (w && WINDOWS.some(x => x.key === w)) return { t: 'tag', w };
  return null;
}

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

function setStatus(text, ok = false) {
  $('status').textContent = text;
  $('status').classList.toggle('ok', ok);
}

function sendTag(tag) {
  if (!tag) return;
  if (conn?.open) {
    send(tag);
    $('tagNote').hidden = false;
    $('tagNote').textContent = tag.s ? 'Fall vom NFC-Tag geladen' : `Fenster vom NFC-Tag: ${WINDOWS.find(x => x.key === tag.w).name}`;
    pendingTag = null;
  } else {
    pendingTag = tag;
  }
}

// ---------- Kopplung ----------
function connect(code) {
  code = code.trim().toLowerCase();
  if (!code) return;
  if (!window.Peer) { setStatus('Kopplung nicht verfügbar'); return; }
  setStatus('Verbinde …');
  peer?.destroy();
  peer = new Peer();
  const timer = setTimeout(() => { if (!conn?.open) setStatus('Keine Verbindung, Code prüfen'); }, 10000);
  peer.on('open', () => {
    conn = peer.connect(`pocus-sim-${code}`, { serialization: 'json' });
    conn.on('open', () => {
      clearTimeout(timer);
      setStatus('Verbunden', true);
      $('pairBox').hidden = true;
      try { localStorage.setItem('pocus-code', code); } catch { /* ohne Speicher muss neu gekoppelt werden */ }
      send({ t: 'hello' });
      sendTag(pendingTag);
    });
    conn.on('data', m => { if (m.t === 'state' && m.probe in PROBES) showProbe(m.probe); });
    conn.on('close', () => { setStatus('Getrennt'); $('pairBox').hidden = false; });
  });
  peer.on('error', err => setStatus(err.type === 'peer-unavailable' ? 'Code nicht gefunden' : `Fehler: ${err.type}`));
}

// ---------- Schallkopf-Anzeige ----------
// Gehäuse verbreitert sich zur Schallfläche bei y = 400, das SVG dreht es dann nach oben. w = halbe Breite des Kopfs.
const HEADS = {
  linear: { w: 82, lens: 'M18 352 h164 v36 q0 10 -10 10 h-144 q-10 0 -10 -10 z' },
  convex: { w: 78, lens: 'M22 350 h156 q2 28 -14 40 q-64 18 -128 0 q-16 -12 -14 -40 z' },
  phased: { w: 46, lens: 'M54 352 h92 v38 q0 8 -8 8 h-76 q-8 0 -8 -8 z' },
};
function showProbe(key) {
  probe = key;
  const { w, lens } = HEADS[key];
  const l = 100 - w, r = 100 + w;
  $('probeBody').setAttribute('d',
    `M78 84 H122 Q130 84 132 94 L136 184 Q140 250 ${r} 300 L${r} 354 L${l} 354 L${l} 300 Q60 250 64 184 L68 94 Q70 84 78 84 Z`);
  $('probeGrip').setAttribute('d', 'M74 100 H126 L129 148 Q100 156 71 148 Z');
  $('probeLens').setAttribute('d', lens);
  $('probeMarker').setAttribute('transform', `translate(${l - 10} 318)`);
  // Marker liegt nach der Drehung an der rechten Kante bei y ≈ 60…82
  $('markerLabel').setAttribute('x', r - 4);
  $('markerLabel').setAttribute('y', 75);
  $('probeName').textContent = `${PROBES[key].name} · ${PROBES[key].mhz} MHz`;
  for (const b of document.querySelectorAll('#probeTypes button')) b.classList.toggle('active', b.dataset.key === key);
}

// ---------- Sensoren ----------
let lastSent = 0;
function onOrientation(e) {
  if (e.alpha === null) return;
  gotEvent = true;
  const now = performance.now();
  if (now - lastSent < 15) return;
  lastSent = now;
  send({ t: 'pose', q: quatFromEuler(e.alpha, e.beta, e.gamma) });
}

async function lockScreen() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Bildschirm bleibt dann evtl. nicht wach */ }
}

async function startSensors() {
  if (!window.isSecureContext) { setStatus('HTTPS nötig für Sensoren'); return false; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') { setStatus('Sensoren abgelehnt'); return false; }
    }
    window.addEventListener('deviceorientation', onOrientation);
    sensorsOn = true;
    setTimeout(() => { if (!gotEvent) setStatus('Keine Sensordaten vom Handy'); }, 2000);
  } catch (err) {
    setStatus(`Sensorfehler: ${err.message}`);
    return false;
  }
  lockScreen();
  // NFC ist experimentell: nur wenn das Handy schon einmal über einen Tag geöffnet wurde
  let nfc = false;
  try { nfc = localStorage.getItem('pocus-nfc') === '1'; } catch { /* kein Speicher */ }
  if (nfc) startNfc();
  return true;
}

// Android (Chrome) kann NFC-Tags direkt in der Seite lesen, das iPhone öffnet die Tag-Adresse selbst
async function startNfc() {
  if (!('NDEFReader' in window)) return;
  try {
    const reader = new NDEFReader();
    await reader.scan();
    reader.addEventListener('reading', ({ message }) => {
      for (const r of message.records) {
        if (r.recordType !== 'url') continue;
        try { sendTag(tagFrom(new URL(new TextDecoder().decode(r.data)).searchParams)); } catch { /* fremder Tag */ }
      }
    });
  } catch { /* NFC aus oder abgelehnt */ }
}

document.addEventListener('visibilitychange', () => {
  if (wakeLock && document.visibilityState === 'visible') lockScreen();
});

// Erster Tipp startet die Sensoren (iPhone fragt dabei nach), jeder Tipp übernimmt die aktuelle Haltung als Standardlage
async function calibrate() {
  if (!sensorsOn && !(await startSensors())) return;
  send({ t: 'calib' });
  $('calibBtn').classList.add('on');
  $('calibText').textContent = 'Kalibriert ✓';
  setTimeout(() => { $('calibText').textContent = 'Kalibrieren'; }, 1200);
}
$('calibBtn').addEventListener('pointerdown', e => e.stopPropagation());
$('calibBtn').addEventListener('click', calibrate);

for (const [key, p] of Object.entries(PROBES)) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.dataset.key = key;
  b.addEventListener('click', () => { showProbe(key); send({ t: 'probe', v: key }); });
  $('probeTypes').append(b);
}

// Wischen auf dem Gehäuse verschiebt die Sonde, Bewegung wird gesammelt und gebündelt geschickt
let swipe = null, swipeSum = [0, 0], swipeTimer = 0;
const pad = $('probeView');
pad.addEventListener('pointerdown', e => { swipe = [e.clientX, e.clientY]; pad.setPointerCapture(e.pointerId); });
pad.addEventListener('pointermove', e => {
  if (!swipe) return;
  swipeSum = [swipeSum[0] + e.clientX - swipe[0], swipeSum[1] + e.clientY - swipe[1]];
  swipe = [e.clientX, e.clientY];
  if (!swipeTimer) swipeTimer = setTimeout(() => { send({ t: 'swipe', d: swipeSum }); swipeSum = [0, 0]; swipeTimer = 0; }, 30);
});
for (const ev of ['pointerup', 'pointercancel']) pad.addEventListener(ev, () => { swipe = null; });

$('pairForm').addEventListener('submit', e => { e.preventDefault(); connect($('codeInput').value); });

showProbe(probe);
let saved = null;
try { saved = localStorage.getItem('pocus-code'); } catch { /* kein Speicher */ }
const code = location.hash.slice(1) || (pendingTag ? saved : null);
if (code) { $('codeInput').value = code; connect(code); }
else if (pendingTag) {
  $('tagNote').hidden = false;
  $('tagNote').textContent = 'Erst einmal per QR-Code koppeln, dann den Tag erneut antippen.';
}
