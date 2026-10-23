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
const SHAPES = {
  linear: 'M40 150 h120 v80 q0 10 -10 10 h-100 q-10 0 -10 -10 z',
  convex: 'M45 140 h110 v70 q-55 45 -110 0 z',
  phased: 'M70 150 h60 v80 q0 10 -10 10 h-40 q-10 0 -10 -10 z',
};
function showProbe(key) {
  probe = key;
  $('probeShape').setAttribute('d', `M60 20 h80 l15 120 h-110 z ${SHAPES[key]}`);
  const left = { linear: 40, convex: 45, phased: 70 }[key];
  $('probeMarker').setAttribute('cx', left - 14);
  $('probeMarker').setAttribute('cy', 200);
  $('probeName').textContent = `${PROBES[key].name} · ${PROBES[key].mhz} MHz`;
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
  startNfc();
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
$('calibBtn').addEventListener('click', async () => {
  if (!sensorsOn && !(await startSensors())) return;
  send({ t: 'calib' });
  $('calibBtn').textContent = 'Kalibriert ✓';
  setTimeout(() => { $('calibBtn').textContent = 'Kalibrieren'; }, 1200);
});

$('probeView').addEventListener('click', () => {
  const keys = Object.keys(PROBES);
  const next = keys[(keys.indexOf(probe) + 1) % keys.length];
  showProbe(next);
  send({ t: 'probe', v: next });
});

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
