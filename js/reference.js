// Echte Aufnahmen zum Vergleich: frei lizenzierte Clips von Wikimedia Commons, direkt von dort geladen
// (nicht im Repo). Pro Schallfenster ein Normalbefund und, falls vorhanden, ein Clip zum Befund.
// Die Clips stammen von verschiedenen Geräten. Ein Graufilter gleicht sie an, crop schneidet
// eingeblendete Texte und Gerätebalken weg (Anteile der Bildfläche: oben, rechts, unten, links).

import { WINDOWS, FINDINGS } from './common.js';

// key = WINDOWS[].key; normal / finding: { src, page, title, artist, license, crop? }
export const REFS = {};

const $ = id => document.getElementById(id);

export class ReferenceClip {
  constructor() {
    this.on = false;
    this.cur = null;
    $('refClose').addEventListener('click', () => this.toggle(false));
  }

  toggle(on = !this.on) {
    this.on = on;
    $('refToggle').checked = on;
    if (!on) { $('refBox').hidden = true; $('refVideo').pause?.(); this.cur = null; }
  }

  // win: Fensterindex, cases: aktive Befunde, hidden: verdeckter Fall (dann nur Normalbefund, sonst wäre er verraten)
  update(win, cases, hidden) {
    if (!this.on) return;
    const w = WINDOWS[win], r = REFS[w.key];
    const f = FINDINGS.find(x => x.win === win);
    const showFinding = !hidden && f && (cases & f.bit) && r?.finding;
    const clip = showFinding ? r.finding : r?.normal;
    const label = showFinding ? f.name : 'Normalbefund';
    const id = clip ? clip.src : `none-${win}`;
    if (id === this.cur) return;
    this.cur = id;
    $('refBox').hidden = false;
    $('refTitle').textContent = `Echte Aufnahme: ${w.name}, ${label}`;
    const vid = $('refVideo'), img = $('refImg');
    if (!clip) {
      vid.hidden = img.hidden = true;
      vid.removeAttribute('src');
      $('refCredit').textContent = 'Für dieses Fenster gibt es noch keinen frei lizenzierten Clip.';
      return;
    }
    const isVideo = /\.(webm|mp4|ogv)$/i.test(clip.src);
    const el = isVideo ? vid : img;
    vid.hidden = !isVideo; img.hidden = isVideo;
    const [t, rt, b, l] = clip.crop || [0, 0, 0, 0];
    el.style.clipPath = `inset(${t * 100}% ${rt * 100}% ${b * 100}% ${l * 100}%)`;
    el.src = clip.src;
    if (isVideo) vid.play().catch(() => { /* Autoplay blockiert: Nutzer klickt auf Play */ });
    const a = Object.assign(document.createElement('a'), { href: clip.page, target: '_blank', rel: 'noopener', textContent: 'Wikimedia Commons' });
    $('refCredit').replaceChildren(`${clip.title} · ${clip.artist} · ${clip.license} · `, a);
  }
}
