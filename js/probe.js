import { PROBES, WINDOWS, quatFromEuler } from './common.js';

const $ = id => document.getElementById(id);
let conn = null;
let wakeLock = null;
let peer = null;
let gotEvent = false;

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

function setStatus(text, ok = false) {
  $('status').textContent = text;
  $('status').classList.toggle('ok', ok);
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
      send({ t: 'hello' });
    });
    conn.on('data', m => { if (m.t === 'state') showState(m); });
    conn.on('close', () => { setStatus('Getrennt'); $('pairBox').hidden = false; });
  });
  peer.on('error', err => setStatus(err.type === 'peer-unavailable' ? 'Code nicht gefunden' : `Fehler: ${err.type}`));
}

function showState(s) {
  for (const b of document.querySelectorAll('#probeButtons button')) b.classList.toggle('active', b.dataset.key === s.probe);
  for (const b of document.querySelectorAll('#winButtons button')) b.classList.toggle('active', +b.dataset.i === s.win);
  $('freezeBtn').classList.toggle('active', s.frozen);
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
  if (!window.isSecureContext) { setStatus('HTTPS nötig für Sensoren'); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') { setStatus('Sensoren abgelehnt'); return; }
    }
    window.addEventListener('deviceorientation', onOrientation);
    $('sensorBtn').textContent = 'Sensoren laufen';
    $('sensorBtn').classList.add('active');
    setTimeout(() => { if (!gotEvent) setStatus('Keine Sensordaten vom Handy'); }, 2000);
  } catch (err) {
    setStatus(`Sensorfehler: ${err.message}`);
  }
  lockScreen();
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock && document.visibilityState === 'visible') lockScreen();
});

// ---------- Bedienelemente ----------
function button(label, onClick, data = {}) {
  const b = document.createElement('button');
  b.textContent = label;
  Object.assign(b.dataset, data);
  b.addEventListener('click', onClick);
  return b;
}

for (const [key, p] of Object.entries(PROBES)) $('probeButtons').append(button(p.name, () => send({ t: 'probe', v: key }), { key }));
WINDOWS.forEach((w, i) => $('winButtons').append(button(w.name, () => send({ t: 'window', v: i }), { i })));
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('click', () => send({ t: b.dataset.cmd, d: +b.dataset.d || 0 }));
}
$('sensorBtn').addEventListener('click', startSensors);
$('pairForm').addEventListener('submit', e => { e.preventDefault(); connect($('codeInput').value); });

// Wischen verschiebt die Sonde: horizontal = lateral, vertikal = in Elevationsrichtung
let last = null;
const pad = $('pad');
pad.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; pad.setPointerCapture(e.pointerId); });
pad.addEventListener('pointerup', () => { last = null; });
pad.addEventListener('pointermove', e => {
  if (!last) return;
  const dx = (e.clientX - last[0]) * 0.02, dz = -(e.clientY - last[1]) * 0.02;
  last = [e.clientX, e.clientY];
  send({ t: 'slide', dx, dz });
});

const code = location.hash.slice(1);
if (code) { $('codeInput').value = code; connect(code); }
