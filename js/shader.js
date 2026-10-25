// Fragment-Shader: berechnet das B-Bild aus einem CT-Volumen (siehe tools/build_volume.py).
// Volumen-Koordinaten in mm (RAS). Pro Pixel wird der Schallstrahl von der Sonde bis zum Bildpunkt
// abgetastet: Dämpfung, Schallschatten hinter Knochen, Reverberation oder Spiegelbild hinter Gas.

import { TISSUES } from './common.js';

const f3 = v => `vec3(${v.map(x => x.toFixed(3)).join(',')})`;
const PAL = `const vec3 PAL[16] = vec3[16](${TISSUES.map(t => f3(t.rgb)).join(', ')});
const int TINTMASK = ${TISSUES.reduce((m, t, i) => m | (t.tint ? 1 << i : 0), 0)};
const float SCAT[16] = float[16](${TISSUES.map(t => t.scat.toFixed(3)).join(', ')});
const float IMP[16] = float[16](${TISSUES.map(t => t.z.toFixed(3)).join(', ')});
const float CELL[16] = float[16](${TISSUES.map(t => (t.cell ?? 1).toFixed(3)).join(', ')});
const float SPKC[16] = float[16](${TISSUES.map(t => (t.spk ?? 1).toFixed(3)).join(', ')});
const float LAY[16] = float[16](${TISSUES.map(t => (t.lay ?? 0).toFixed(3)).join(', ')});`;

export const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `#version 300 es
precision highp float;
precision highp usampler3D;
precision highp sampler3D;
uniform usampler3D uVol;
uniform sampler3D uSm, uBlk;   // geglättete Felder aus fields.js
uniform sampler3D uHrt;        // Herzfeld aus fields.js (buildHeart): R Wandabstand, G Abstand zur Herzoberfläche
uniform vec3 uHC, uHAx;        // Herzmitte (mm) und Längsachse zur Spitze
uniform vec3 uDims;
uniform float uSpacing;
uniform vec2 uRes;
uniform float uDepth, uGain, uTime, uTop;
uniform int uProbe, uWin, uCase, uDebug, uTint;
uniform vec3 uOrigin;   // Sondenmitte auf der Haut, mm
uniform mat3 uRot;      // Spalten: lateral, Tiefe, Elevation (Welt)
out vec4 outColor;
${PAL}


// Gewebeklassen wie in tools/build_volume.py
const int AIR = 0, GAS = 1, FAT = 2, SOFT = 3, LIVER = 4, SPLEEN = 5, KIDNEY = 6, SINUS = 7, BLOOD = 8,
          HEART = 9, BONE = 10, BOWEL = 11, FLUID = 12, SKIN = 13, MUSCLE = 14, CARTILAGE = 15;

// Grauwertkennlinie wie am Gerät: logarithmische Kompression über DR dB.
// G0 legt fest, dass Leberparenchym (Rückstreuung 1) bei Gain 1 auf etwa 33 % Grau liegt,
// gemessen an Konvex-Aufnahmen von Mindray und Butterfly (Median im Fächer 45-70 von 255).
const float DR = 55.0;
const float G0 = 0.0144;
float lin(float v){ return pow(10.0, (v - 1.0)*DR/20.0)/G0; }   // Amplitude für Grauwert v

float hash(vec3 p){ p = fract(p*0.3183099 + vec3(.1,.2,.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
// Gradientenrauschen mit Ganzzahl-Hash (pcg3d), ohne sin(), damit es auch weit vom Ursprung sauber bleibt
uvec3 pcg3d(uvec3 v){
  v = v*1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}
float gcorner(ivec3 i, vec3 f){ return dot(vec3(pcg3d(uvec3(i + 65536)) >> 8u)*(2.0/16777215.0) - 1.0, f); }
float gnoise(vec3 x){
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x);
  vec3 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  return mix(mix(mix(gcorner(i, f), gcorner(i+ivec3(1,0,0), f-vec3(1,0,0)), u.x),
                 mix(gcorner(i+ivec3(0,1,0), f-vec3(0,1,0)), gcorner(i+ivec3(1,1,0), f-vec3(1,1,0)), u.x), u.y),
             mix(mix(gcorner(i+ivec3(0,0,1), f-vec3(0,0,1)), gcorner(i+ivec3(1,0,1), f-vec3(1,0,1)), u.x),
                 mix(gcorner(i+ivec3(0,1,1), f-vec3(0,1,1)), gcorner(i+ivec3(1,1,1), f-vec3(1,1,1)), u.x), u.y), u.z);
}
// Hüllkurve zweier unabhängiger Felder (I/Q): Rayleigh-verteilt wie voll entwickeltes Speckle, Mittelwert 1
float rayleigh(vec3 q){ float a = gnoise(q), b = gnoise(q + vec3(31.7, 17.3, 5.1)); return sqrt(a*a + b*b)*4.13; }

float breath(){ return sin(uTime*6.2832/4.0); }
float systole(){ float ph = fract(uTime/0.9); return smoothstep(0.0,0.15,ph)*(1.0-smoothstep(0.35,0.6,ph)); }

// Herzfeld am Punkt p: x = Abstand zur nächsten Wand (mm), y = Abstand zur Herzoberfläche (mm, innen positiv)
vec2 heart(vec3 p){
  vec2 h = texture(uHrt, p/(uDims*uSpacing)).rg*255.0;
  return vec2(h.x/8.0, (h.y - 128.0)/8.0);
}
// Herzschlag als inverse Verformung: zu einem Punkt im schlagenden Herzen den Ort in Ruhelage suchen.
// Das Herz verkürzt sich längs und zieht sich radial zusammen, Gewebe und Speckle wandern dadurch mit
// dem Muskel. Außerhalb des Herzens (Erguss, Perikard, Leber) bewegt sich nichts.
vec3 beatInverse(vec3 p){
  if (uWin != 2) return p;
  float w = smoothstep(-2.0, 1.0, heart(p).y);
  if (w <= 0.0) return p;
  vec3 r = p - uHC;
  float a = dot(r, uHAx);
  vec3 rad = r - a*uHAx;
  float s = systole();
  vec3 q = uHC + uHAx*a/(1.0 - 0.05*s) + rad/(1.0 - 0.07*s);
  return mix(p, q, w);
}

// Atemverschiebung der Bauchorgane (nicht der Bauchwand) entlang der Körperlängsachse
vec3 moved(vec3 p, float depthMm){
  if (uWin > 1) return p;
  return p + vec3(0.0, 0.0, breath()*7.0*smoothstep(15.0, 35.0, depthMm));
}

uvec4 voxel(vec3 p){
  // Dithering glättet Kanten. Auf ein 0,5-mm-Raster bezogen, damit Zittern der Hand das Bild nicht krisseln lässt.
  vec3 q = floor(p*2.0)*0.5;
  vec3 g = p/uSpacing + (vec3(hash(q*3.1), hash(q*5.7+1.0), hash(q*7.3+2.0)) - 0.5)*1.3;
  ivec3 i = ivec3(floor(g));
  if (any(lessThan(i, ivec3(0))) || any(greaterThanEqual(i, ivec3(uDims)))) return uvec4(0u);
  return texelFetch(uVol, i, 0);
}

int classOf(uvec4 v){
  int c = int(v.r);
  if ((int(v.a) & 15 & uCase) != 0 && c != BONE) c = FLUID;   // freie Flüssigkeit / Erguss
  if (c == HEART && float(v.b)*0.5 > 6.0 + 4.0*systole()) c = BLOOD; // Kammern schlagen mit
  return c;
}

float atten(int c){
  if (c == FLUID) return 0.05;
  if (c == BLOOD) return 0.15;
  if (c == FAT) return 0.6;
  if (c == MUSCLE) return 0.9;
  if (c == LIVER || c == SPLEEN) return 0.55;
  if (c == CARTILAGE) return 0.5;
  return 0.7;
}

int blocker(int c){ return c == BONE ? 1 : (c == GAS ? 2 : (c == AIR ? 3 : 0)); }

// Unterhautfett ist echoarm, Fett in der Bauchhöhle (perirenal, Mesenterium) echoreich.
// Das CT unterscheidet beides nicht, deshalb entscheidet der Strahlweg: liegt schon Muskel oder ein Organ davor, ist es viszeral.
float FATK = 0.32;
// Speckle-Kontrast und Helligkeit dünner Schichten, abgeglichen an den Referenzaufnahmen
const float SPK_K = 1.08, RIDGE_K = 300.0;

// Glattes Gewebe am Punkt p (x = Rückstreuung, y = Impedanz) aus den vorberechneten Feldern.
// Freie Flüssigkeit der aktiven Fälle ersetzt das Gewebe, die schlagenden Herzhöhlen kommen trilinear
// aus dem Rohvolumen dazu (nur im Herzfenster).
bool DYN = false;
vec3 FLON = vec3(0.0);
vec2 tissue(vec3 p){
  if (DYN) p = beatInverse(p);
  vec3 t = p/(uDims*uSpacing);
  vec4 a = texture(uSm, t);
  float s = a.r*3.0 + a.g*2.75*FATK;
  float z = 1.3 + a.b*0.7;
  // schmale Flüssigkeitssäume verlieren durch die Glättung an Tiefe, deshalb geschärft
  float fl = smoothstep(0.15, 0.5, dot(texture(uBlk, t).gba, FLON));
  s = mix(s, SCAT[FLUID], fl);
  z = mix(z, IMP[FLUID], fl);
  if (DYN){
    // Kammern aus dem Herzfeld: weiche, runde Grenzen statt Voxelstufen
    vec2 hf = heart(p);
    float thr = 6.0 + 2.5*systole();
    float ch = smoothstep(-0.6, 0.6, hf.y)*smoothstep(thr - 0.8, thr + 0.8, hf.x);
    s = mix(s, SCAT[BLOOD], ch);
    z = mix(z, IMP[BLOOD], ch);
  }
  return vec2(s, z);
}

int classAt(vec3 p){ return classOf(voxel(p)); }

// Luftanteil (außerhalb des Körpers), trilinear aus den 8 Nachbarvoxeln
float airFrac(vec3 p){
  vec3 g = p/uSpacing - 0.5;
  ivec3 i0 = ivec3(floor(g));
  vec3 f = fract(g);
  float acc = 0.0;
  for (int k = 0; k < 8; k++){
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    vec3 w3 = mix(1.0 - f, f, vec3(o));
    ivec3 ii = i0 + o;
    bool inside = all(greaterThanEqual(ii, ivec3(0))) && all(lessThan(ii, ivec3(uDims)));
    if (!inside || texelFetch(uVol, ii, 0).r == 0u) acc += w3.x*w3.y*w3.z;
  }
  return acc;
}

// Anpressdruck: Liegt die Haut unter einem Strahl um gOff tiefer (gekrümmte Körperoberfläche),
// wird nur das oberflächliche Gewebe bis LS mm Tiefe hochgezogen. Tiefe Organe bleiben, wo sie sind,
// sonst wird das Bild verzerrt, sobald die Sonde quer zu einer Rundung steht.
float gOff = 0.0;
const float LS = 45.0;
float warp(float s){ return s < LS ? gOff + s*(LS - gOff)/LS : s; }
vec3 at(vec3 S, vec3 dir, float s){ return S + dir*warp(s); }

// Anteil Knochen bzw. Gas aus den geglätteten Feldern: glatte Oberfläche statt Voxeltreppe
float blockFrac(vec3 p, int kind){
  vec3 t = p/(uDims*uSpacing);
  return kind == 1 ? texture(uSm, t).a : texture(uBlk, t).r;
}

// Wie senkrecht trifft der Strahl die Knochen- bzw. Gasoberfläche? Streifend getroffene Flanken
// (Seiten einer Rippe, Darmschlinge) werfen kaum Echo zurück, sonst leuchten sie als falsche Linien.
float facing(vec3 X, vec3 dir, int kind){
  float h = 0.75*uSpacing;
  vec3 n = vec3(blockFrac(X + vec3(h,0,0), kind) - blockFrac(X - vec3(h,0,0), kind),
                blockFrac(X + vec3(0,h,0), kind) - blockFrac(X - vec3(0,h,0), kind),
                blockFrac(X + vec3(0,0,h), kind) - blockFrac(X - vec3(0,0,h), kind));
  return abs(dot(n, dir))/(length(n) + 1e-4);
}

// Genaue Lage der Knochen- oder Gasoberfläche zwischen a und b (etwas Spielraum nach vorn)
float refine(vec3 S, vec3 dir, float a, float b, int kind){
  a = max(a - uSpacing, 0.0);
  for (int i = 0; i < 7; i++){
    float m = 0.5*(a+b);
    if (blockFrac(moved(at(S, dir, m), m), kind) > 0.5) b = m; else a = m;
  }
  return b;
}

// Speckle: im Gewebe verankert (Weltpunkt), im Sondensystem gestreckt. Körnchen sind quer zum Strahl
// länger als längs und werden mit der Tiefe breiter (Strahlaufweitung). Drehpunkt ist die Volumenmitte,
// damit Kippen der Sonde das Muster nicht über den ganzen Schirm rasen lässt.
vec3 SPK_CELL; float SPK_GROW;
float speckleAt(vec3 X, float depthMm, float seed, float cellMul){
  vec3 q = transpose(uRot)*(X - 0.5*uDims*uSpacing);
  vec3 cell = SPK_CELL*cellMul*vec3(1.0 + SPK_GROW*depthMm, 1.0, 1.0);
  vec3 u = q/cell + seed;
  // Teilbild 1 quer zum Strahl verschmiert (drei seitliche Abtastungen): ergibt die leicht strähnige,
  // quer gestreckte Körnung echter Geräte. Teilbild 2 wie bei Compounding am Gerät: weniger schwarze Löcher.
  float a = 0.5*rayleigh(u) + 0.25*(rayleigh(u - vec3(0.45, 0.0, 0.0)) + rayleigh(u + vec3(0.45, 0.0, 0.0)));
  float b = rayleigh(q/cell*1.31 + seed + 11.0);
  return 0.5*(a + b);
}
float speckleAt(vec3 X, float depthMm, float seed){ return speckleAt(X, depthMm, seed, 1.0); }

// Schichtung parallel zur Sondenfläche (Muskelfasern, strähniges Myokard), im Gewebe verankert
float layering(vec3 X, int c){
  if (LAY[c] <= 0.0) return 1.0;
  vec3 q = transpose(uRot)*(X - 0.5*uDims*uSpacing);
  return max(1.0 + LAY[c]*1.6*gnoise(q*vec3(0.12, 0.9, 0.15)), 0.0);
}
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float sc = uRes.y / (uDepth + uTop);
  vec2 ic = vec2((px.x - 0.5*uRes.x)/sc, px.y/sc - uTop);   // cm

  bool ok; vec2 s2; float len; float mask = 1.0; float th = 0.0, edge = 0.0;
  if (uProbe == 0){
    ok = abs(ic.x) < 2.0 && ic.y >= 0.0 && ic.y <= uDepth;
    s2 = vec2(ic.x, 0.0); len = ic.y;
    mask = 1.0 - smoothstep(1.92, 2.0, abs(ic.x));
    edge = abs(ic.x)/2.0;
  } else if (uProbe == 1){
    float R = 4.0; vec2 a = vec2(0.0, -R); vec2 rel = ic - a; float rho = length(rel); th = atan(rel.x, rel.y);
    ok = abs(th) < 0.62 && rho >= R && rho - R <= uDepth;
    s2 = a + rel/rho*R; len = rho - R;
    mask = 1.0 - smoothstep(0.6, 0.62, abs(th));
    edge = abs(th)/0.62;
  } else {
    float rho = length(ic); th = atan(ic.x, ic.y);
    ok = abs(th) < 0.78 && rho <= uDepth && ic.y > 0.0;
    s2 = vec2(0.0); len = rho;
    mask = 1.0 - smoothstep(0.76, 0.78, abs(th));
    edge = abs(th)/0.78;
  }
  // Anatomieansicht: ganze Schnittebene in Gewebefarben, außerhalb des Fächers abgedunkelt
  if (uDebug == 1){
    if (ic.y < -uTop){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float o = 0.0;
    for (int i = 0; i < 30; i++){
      if (classAt(uOrigin + uRot[1]*o) != AIR) break;
      o += 1.0;
    }
    vec3 Pa = uOrigin + uRot*(vec3(ic.x, max(ic.y, 0.0), 0.0)*10.0) + uRot[1]*(o >= 30.0 ? 0.0 : o);
    vec3 col = PAL[classAt(Pa)];
    float e = ok ? 1.0 - mask : 0.0;
    col = mix(col*(ok ? 1.0 : 0.35), vec3(0.3, 0.7, 1.0), e);
    if (ic.y < 0.0) col *= 0.2;
    outColor = vec4(col, 1.0); return;
  }
  if (!ok){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Konvexe Sonde: Ankopplungsfläche liegt auf der Haut, nicht darüber
  float lift = uProbe == 1 ? 4.0 - 4.0*cos(atan(s2.x, s2.y + 4.0)) : 0.0;
  vec3 S = uOrigin + uRot*(vec3(s2.x, s2.y + lift, 0.0)*10.0);
  vec3 P = uOrigin + uRot*(vec3(ic.x, ic.y + lift, 0.0)*10.0);
  vec3 dir = normalize(P - S + uRot[1]*1e-4);
  vec3 latDir = normalize(cross(uRot[2], dir));
  float L = len*10.0;                      // mm
  float f = uProbe == 0 ? 7.5 : (uProbe == 1 ? 3.5 : 2.5);

  // Die Sonde drückt das Gewebe ein: Strahl beginnt am ersten Körpervoxel (bis 3 cm Luftspalt)
  float off = 0.0;
  for (int i = 0; i < 30; i++){
    if (classAt(S + dir*off) != AIR) break;
    off += 1.0;
  }
  if (off >= 30.0){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // Hautoberfläche auf Bruchteile eines Millimeters genau, sonst springt das Bild spaltenweise (senkrechte Streifen)
  float a0 = max(off - 1.5, 0.0), b0 = off + 0.5;
  for (int i = 0; i < 6; i++){
    float m = 0.5*(a0 + b0);
    if (airFrac(S + dir*m) < 0.5) b0 = m; else a0 = m;
  }
  off = b0;
  gOff = off;
  P = at(S, dir, L);

  // Schallkeule: neben dem Hauptstrahl zwei Nachbarstrahlen im Abstand der halben Keulenbreite.
  // Schatten hinter Rippen und Darmgas werden dadurch an den Rändern weich wie am Gerät.
  float beamW = (uProbe == 0 ? 0.5 : 1.0) + L*(uProbe == 0 ? 0.015 : 0.03);
  float att = 0.0, boneD = -1.0, gasD = -1.0, prev = 0.0;
  float lBone = 0.0, rBone = 0.0, lGas = 0.0, rGas = 0.0;   // wie weit die Nachbarstrahlen schon blockiert sind
  int before = SKIN;
  bool deep = false;
  float stp = max(uDepth*10.0/90.0, 0.75);
  for (int i = 0; i < 140; i++){
    float s = (float(i)+0.5)*stp;
    if (s >= L) break;
    vec3 X = moved(at(S, dir, s), s);
    int c = classAt(X);
    att += atten(c)*stp*0.1;
    // Knochen und Gas über die geglätteten Felder: Oberflächen ohne Voxeltreppe
    if (boneD < 0.0 && blockFrac(X, 1) > 0.5) boneD = refine(S, dir, prev, s, 1);
    if (blockFrac(X, 2) > 0.5){ gasD = refine(S, dir, prev, s, 2); break; }
    if (blocker(c) == 0) before = c;
    if (c == MUSCLE || c == LIVER || c == SPLEEN || c == KIDNEY || c == HEART || c == BOWEL || c == BLOOD) deep = true;
    if ((i & 1) == 0){                     // Nachbarstrahlen nur jeden zweiten Schritt, spart Rechenzeit
      float bw = beamW*min(1.0, s/L + 0.3);
      vec3 Xl = X - latDir*bw, Xr = X + latDir*bw;
      lBone = max(lBone, blockFrac(Xl, 1)); rBone = max(rBone, blockFrac(Xr, 1));
      lGas = max(lGas, blockFrac(Xl, 2)); rGas = max(rGas, blockFrac(Xr, 2));
    }
    prev = s;
  }
  vec3 Pm = moved(P, L);
  int c = classAt(Pm);
  float sideBone = 0.5*(clamp((lBone - 0.2)/0.6, 0.0, 1.0) + clamp((rBone - 0.2)/0.6, 0.0, 1.0));
  float sideGas = 0.5*(clamp((lGas - 0.2)/0.6, 0.0, 1.0) + clamp((rGas - 0.2)/0.6, 0.0, 1.0));
  FATK = deep ? 1.25 : 0.32;
  DYN = uWin == 2;
  FLON = vec3((uCase & 1) != 0 ? 1.0 : 0.0, (uCase & 2) != 0 ? 1.0 : 0.0, (uCase & (uWin == 2 ? 4 : 8)) != 0 ? 1.0 : 0.0);

  // Tiefenausgleich (TGC) gleicht die mittlere Dämpfung aus, nicht die tatsächliche:
  // hinter Flüssigkeit wird es heller (Schallverstärkung), ganz unten fällt das Bild ab.
  float netDb = 0.6*f*(att - 0.6*min(len, 140.0*stp*0.1));
  float amp = pow(10.0, -netDb/20.0) * exp(-len*f*0.012);

  // Speckle: Körnchengröße je Sonde (Frequenz), gemessen an Leberparenchym in den Referenzaufnahmen
  // (Konvex: Halbwertsbreite der Autokorrelation quer etwa 2,6 mm, längs etwa 1 mm)
  SPK_CELL = uProbe == 0 ? vec3(1.6, 0.6, 1.5) : (uProbe == 1 ? vec3(3.6, 1.3, 3.0) : vec3(4.0, 1.5, 3.5));
  SPK_GROW = uProbe == 0 ? 0.01 : 0.012;
  vec3 Pr = DYN ? beatInverse(Pm) : Pm;   // Speckle wandert mit dem Herzmuskel
  float spk = max(mix(1.0, speckleAt(Pr, L, 0.0, CELL[c]), SPK_K*SPKC[c]), 0.0);

  // Rückstreuung und spiegelnde Grenzflächen aus dem Impedanzsprung längs des Strahls.
  // Senkrecht getroffene Grenzen (Kapsel, Zwerchfell, Blasenwand) leuchten, schräge kaum.
  // Gradient über knapp einen Voxel, damit die Treppenstufen des CT-Rasters nicht als Linien aufleuchten
  float h = 0.45*uSpacing;
  vec2 T0 = tissue(Pm);
  float Zb = tissue(moved(at(S, dir, L - h), L - h)).y, Zf = tissue(moved(at(S, dir, L + h), L + h)).y;
  float Zl = tissue(Pm - latDir*h).y, Zr = tissue(Pm + latDir*h).y;
  float gb = Zf - Zb, gl = Zr - Zl;
  float R = abs(gb)/(Zf + Zb);
  float cosA = abs(gb)/(sqrt(gb*gb + gl*gl) + 1e-5);
  float specMod = 0.6 + 0.8*gnoise(transpose(uRot)*Pm*vec3(0.25, 1.0, 0.25)) + 0.2;
  float A = T0.x*spk*layering(Pr, c) + 160.0*R*pow(cosA, 3.0)*specMod;
  // Dünne Schichten (Faszien, Kapseln, Zwerchfell, Gefäßwände) werfen zwei dicht beieinander liegende
  // Echos zurück und erscheinen als helle Linie. Erkannt an der Krümmung der Impedanz längs des Strahls.
  float h2 = 1.2;
  float Zb2 = tissue(moved(at(S, dir, L - h2), L - h2)).y, Zf2 = tissue(moved(at(S, dir, L + h2), L + h2)).y;
  // Nur echte Grate (Mitte heller oder dunkler als beide Seiten), eine einfache Stufe zählt nicht
  float db = T0.y - Zb2, df = T0.y - Zf2;
  float rid = max(min(db, df), min(-db, -df));
  A += RIDGE_K*max(rid, 0.0)*cosA*cosA*max(specMod, 0.2);
  // Perikard: heller Saum um das Herz, bei Erguss außen um die Flüssigkeit. Es schlägt nicht mit.
  if (DYN){
    float periD = (uCase & 4) != 0 ? 9.0 : 1.0;
    float u = (heart(Pm).y + periD)/0.8;
    A += lin(0.78)*exp(-u*u)*(0.6 + 0.4*spk);
  }

  // Knochen: helle Oberfläche, dahinter Schatten (anteilig über die Keule)
  float shadow = 0.0;
  if (boneD < 0.0 && blockFrac(Pm, 1) > 0.5) boneD = refine(S, dir, max(L - 4.0, 0.0), L, 1);
  if (boneD >= 0.0){
    float d = L - boneD;
    float surf = (1.0 - smoothstep(0.8, 2.6, d))*smoothstep(0.3, 0.7, facing(moved(at(S, dir, boneD), boneD), dir, 1));
    shadow = smoothstep(1.0, 3.0, d);
    A = mix(A, lin(0.97)*(0.7 + 0.6*vnoise(Pm*vec3(0.6, 1.2, 0.6))), surf);
  }
  shadow = shadow*0.34 + sideBone*0.66;
  A *= mix(1.0, 0.03, shadow);

  if (gasD < 0.0 && blockFrac(Pm, 2) > 0.5) gasD = refine(S, dir, max(L - 4.0, 0.0), L, 2);
  if (gasD >= 0.0){
    float g = gasD;
    float d = L - g;
    bool lungWin = uWin >= 4;
    bool ptx = (uWin == 4 && (uCase & 16) != 0) || (uWin == 5 && (uCase & 32) != 0);
    bool mirror = before == LIVER || before == SPLEEN;   // Zwerchfell: Spiegelartefakt statt A-Linien
    float slideX = (lungWin && !ptx) ? breath()*3.5 : 0.0;
    vec3 sp = (P + uRot[0]*slideX) * 1.4;
    float Ag;
    // helle Grenzfläche (Pleuralinie, Darmwand, Zwerchfell)
    float surf = (1.0 - smoothstep(0.7, 1.8, d))*smoothstep(lungWin ? 0.05 : 0.3, lungWin ? 0.3 : 0.7, facing(moved(at(S, dir, g), g), dir, 2));
    if (surf > 0.999){
      Ag = 0.0;
    } else if (mirror){
      vec3 Q = moved(at(S, dir, g - d), g - d);
      Ag = 0.5*tissue(Q).x*speckleAt(Q, L, 0.0);
    } else {
      float m = max(round(L/g), 2.0);
      float u = (L - m*g)/0.9;
      float al = exp(-u*u) * pow(lungWin ? (ptx ? 0.62 : 0.52) : 0.35, m - 1.0);
      float shimmer = (lungWin && !ptx) ? vnoise(sp*0.6 + vec3(0.0, 0.0, uTime*1.5))*exp(-d*0.3) : 0.0;
      Ag = lin(0.9)*al*(0.8 + 0.4*vnoise(sp*0.5)) + 0.5*shimmer*spk + 0.08*spk;
      if (lungWin) Ag += 0.45*spk*exp(-d/80.0);   // Reverberationsschleier unter der Pleura
    }
    // Darmgas im Bauch: der Schatten ist "schmutzig" grau, nicht schwarz
    if (!lungWin && !mirror) Ag += 0.12*spk*exp(-d*0.02);
    A = mix(Ag, lin(0.95)*(0.7 + 0.5*vnoise(sp)), surf);
  } else if (sideGas > 0.0){
    A *= 1.0 - 0.6*sideGas;
  }

  // Elektronisches Rauschen: wird mit der Tiefe vom TGC mitverstärkt, füllt echofreie Flächen leicht
  float noise = 0.05*(1.0 + L/60.0)*speckleAt(Pm*2.0, 0.0, 57.0);
  float I = uGain*sqrt(A*A*amp*amp + noise*noise);
  I *= 1.0 - 0.35*pow(edge, 4.0);          // Randabfall des Fächers
  float v = 1.0 + 20.0*log(max(I*G0, 1e-6))/log(10.0)/DR;
  v = clamp(v, 0.0, 1.0) * mask;
  vec3 col = vec3(v) * vec3(1.0, 0.99, 0.96);
  // Organe leicht einfärben, damit man erkennt, was was ist
  if (uTint == 1 && ((TINTMASK >> c) & 1) == 1 && boneD < 0.0 && gasD < 0.0){
    vec3 pc = PAL[c] / max(max(PAL[c].r, PAL[c].g), PAL[c].b);
    col = col*mix(vec3(1.0), pc, 0.35) + pc*0.05*mask;
  }
  outColor = vec4(col, 1.0);
}`;
