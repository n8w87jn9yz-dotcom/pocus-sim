// Echte Aufnahmen zum Vergleich: frei lizenzierte Clips von Wikimedia Commons, direkt von dort geladen
// (nicht im Repo). Pro Schallfenster ein Normalbefund und, falls vorhanden, ein Clip zum Befund.
// Die Clips stammen von verschiedenen Geräten. Ein Graufilter gleicht sie an, crop schneidet
// eingeblendete Texte und Gerätebalken weg (Anteile der Bildfläche: oben, rechts, unten, links).

import { WINDOWS, FINDINGS } from './common.js';

// key = WINDOWS[].key; normal / finding: { src, page, title, artist, license, crop? }
// Videos als H.264-Ableitung von Commons (.mpeg4.mov), läuft auch in Safari. Für die Blase normal gibt es noch nichts.
export const REFS = {
  ruq: {
    normal: { src: "https://upload.wikimedia.org/wikipedia/commons/f/fa/MorisonNoText.png",
        page: "https://commons.wikimedia.org/wiki/File:MorisonNoText.png",
        title: "Morison-Pouch normal: Leber und rechte Niere (Standbild)", artist: "Drahreg01", license: "CC BY-SA 3.0", crop: [0.07, 0.2, 0.1, 0.08] },
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/7/70/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S1.ogv/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S1.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S1.ogv",
        title: "RUQ: freie Flüssigkeit im Morison-Pouch", artist: "Gillman L, Ball C, Panebianco N, Al-Kadi A, Kirkpatrick A", license: "CC BY 2.0", crop: [0.03, 0.12, 0.05, 0.12] },
  },
  luq: {
    normal: { src: "https://upload.wikimedia.org/wikipedia/commons/6/6d/Ultrasound_image_of_spleen_110314102702_1031200.jpg",
        page: "https://commons.wikimedia.org/wiki/File:Ultrasound_image_of_spleen_110314102702_1031200.jpg",
        title: "LUQ normal: Milz (Standbild, mit Messkreuzen)", artist: "Nevit Dilmen", license: "CC BY-SA 3.0", crop: [0.17, 0.03, 0.07, 0.3] },
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/b/b9/Ultrasound_Scan_ND_110222095049_0956280.jpg",
        page: "https://commons.wikimedia.org/wiki/File:Ultrasound_Scan_ND_110222095049_0956280.jpg",
        title: "LUQ: Milz mit freier Flüssigkeit (Standbild)", artist: "Nevit Dilmen", license: "CC BY-SA 3.0", crop: [0.18, 0.03, 0.07, 0.26] },
  },
  subxiphoid: {
    normal: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/e/e0/Respiratory-maneuvers-in-echocardiography-a-review-of-clinical-applications-1476-7120-7-42-S5.ogv/Respiratory-maneuvers-in-echocardiography-a-review-of-clinical-applications-1476-7120-7-42-S5.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Respiratory-maneuvers-in-echocardiography-a-review-of-clinical-applications-1476-7120-7-42-S5.ogv",
        title: "Subkostaler Vierkammerblick normal (Inspiration)", artist: "Ginghina C, Beladan C, Iancu M, Calin A et al.", license: "CC BY 2.0", crop: [0.05, 0.08, 0.1, 0.32] },
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/7/7f/Pericardial_effusion%2C_%22swinging_heart%22_E00670_%28CardioNetworks_ECHOpedia%29.webm/Pericardial_effusion%2C_%22swinging_heart%22_E00670_%28CardioNetworks_ECHOpedia%29.webm.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Pericardial_effusion,_%22swinging_heart%22_E00670_(CardioNetworks_ECHOpedia).webm",
        title: "Perikarderguss mit swinging heart, subkostal", artist: "CardioNetworks: Secretariat", license: "CC BY-SA 3.0", crop: [0, 0.07, 0.12, 0.27] },
  },
  pelvis: {
    normal: null,
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/4/40/Focused-assessment-with-sonography-for-HIV-associated-tuberculosis-%28FASH%29-a-short-protocol-and-a-2036-7902-4-21-S8.ogv/Focused-assessment-with-sonography-for-HIV-associated-tuberculosis-%28FASH%29-a-short-protocol-and-a-2036-7902-4-21-S8.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Focused-assessment-with-sonography-for-HIV-associated-tuberculosis-(FASH)-a-short-protocol-and-a-2036-7902-4-21-S8.ogv",
        title: "Becken: freie Flüssigkeit im Douglas-Raum", artist: "Heller T, Wallrauch C, Goblirsch S, Brunetti E", license: "CC BY 2.0", crop: [0.15, 0.2, 0.08, 0.13] },
  },
  lung_r: {
    normal: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ae/Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv/Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv",
        title: "Lunge normal: Pleuragleiten (Bat-Sign)", artist: "Gillman L, Kirkpatrick A", license: "CC BY 2.0", crop: [0.11, 0.1, 0.08, 0.17] },
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f8/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv",
        title: "Pneumothorax: fehlendes Pleuragleiten", artist: "Gillman L, Ball C, Panebianco N, Al-Kadi A, Kirkpatrick A", license: "CC BY 2.0", crop: [0.07, 0.1, 0.08, 0.22] },
  },
  lung_l: {
    normal: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ae/Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv/Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Portable-bedside-ultrasound-the-visual-stethoscope-of-the-21st-century-1757-7241-20-18-S1.ogv",
        title: "Lunge normal: Pleuragleiten (Bat-Sign)", artist: "Gillman L, Kirkpatrick A", license: "CC BY 2.0", crop: [0.11, 0.1, 0.08, 0.17] },
    finding: { src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f8/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv/Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv.360p.mpeg4.mov",
        page: "https://commons.wikimedia.org/wiki/File:Clinician-performed-resuscitative-ultrasonography-for-the-initial-evaluation-and-resuscitation-of-1757-7241-17-34-S4.ogv",
        title: "Pneumothorax: fehlendes Pleuragleiten", artist: "Gillman L, Ball C, Panebianco N, Al-Kadi A, Kirkpatrick A", license: "CC BY 2.0", crop: [0.07, 0.1, 0.08, 0.22] },
  },
};

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
    const id = `${win}:${showFinding ? 1 : 0}:${clip?.src}`;
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
    const isVideo = /\.(webm|mp4|mov|ogv)$/i.test(clip.src);
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
