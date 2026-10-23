// Fragment-Shader: berechnet das B-Bild aus einem CT-Volumen (siehe tools/build_volume.py).
// Volumen-Koordinaten in mm (RAS). Pro Pixel wird der Schallstrahl von der Sonde bis zum Bildpunkt
// abgetastet: Dämpfung, Schallschatten hinter Knochen, Reverberation oder Spiegelbild hinter Gas.

import { TISSUES } from './common.js';

const f3 = v => `vec3(${v.map(x => x.toFixed(3)).join(',')})`;
const PAL = `const vec3 PAL[16] = vec3[16](${TISSUES.map(t => f3(t.rgb)).join(', ')});
const int TINTMASK = ${TISSUES.reduce((m, t, i) => m | (t.tint ? 1 << i : 0), 0)};`;

export const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `#version 300 es
precision highp float;
precision highp usampler3D;
uniform usampler3D uVol;
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

float hash(vec3 p){ p = fract(p*0.3183099 + vec3(.1,.2,.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float breath(){ return sin(uTime*6.2832/4.0); }
float systole(){ float ph = fract(uTime/0.9); return smoothstep(0.0,0.15,ph)*(1.0-smoothstep(0.35,0.6,ph)); }

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

float echo(int c, vec3 p){
  float n = vnoise(p*0.09);
  if (c == FAT) return 0.14 + 0.5*step(0.84, vnoise(p*vec3(0.15,0.15,0.9)));
  if (c == SOFT) return 0.42*(0.6+0.8*n);
  if (c == LIVER) return 0.5*(0.75+0.5*n);
  if (c == SPLEEN) return 0.55*(0.8+0.4*n);
  if (c == KIDNEY) return 0.3;
  if (c == SINUS) return 0.8*(0.6+0.8*vnoise(p*0.3));
  if (c == BLOOD || c == FLUID) return 0.015;
  if (c == HEART) return 0.5*(0.7+0.6*n);
  if (c == BOWEL) return 0.45*(0.5+1.0*vnoise(p*0.2));
  if (c == SKIN) return 0.75;
  if (c == MUSCLE) return 0.34*(0.7+0.6*vnoise(p*vec3(0.5,0.5,0.08)));
  if (c == CARTILAGE) return 0.06;
  return 0.0;
}

bool similar(int a, int b){
  bool wa = a == FAT || a == MUSCLE || a == SOFT || a == SKIN;
  bool wb = b == FAT || b == MUSCLE || b == SOFT || b == SKIN;
  return a == b || (wa && wb);
}

int classAt(vec3 p){ return classOf(voxel(p)); }

// Anpressdruck: Liegt die Haut unter einem Strahl um gOff tiefer (gekrümmte Körperoberfläche),
// wird nur das oberflächliche Gewebe bis LS mm Tiefe hochgezogen. Tiefe Organe bleiben, wo sie sind,
// sonst wird das Bild verzerrt, sobald die Sonde quer zu einer Rundung steht.
float gOff = 0.0;
const float LS = 45.0;
float warp(float s){ return s < LS ? gOff + s*(LS - gOff)/LS : s; }
vec3 at(vec3 S, vec3 dir, float s){ return S + dir*warp(s); }

float refine(vec3 S, vec3 dir, float a, float b, int kind){
  for (int i = 0; i < 6; i++){
    float m = 0.5*(a+b);
    if (blocker(classAt(moved(at(S, dir, m), m))) == kind) b = m; else a = m;
  }
  return b;
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float sc = uRes.y / (uDepth + uTop);
  vec2 ic = vec2((px.x - 0.5*uRes.x)/sc, px.y/sc - uTop);   // cm

  bool ok; vec2 s2; float len; float mask = 1.0;
  if (uProbe == 0){
    ok = abs(ic.x) < 2.0 && ic.y >= 0.0 && ic.y <= uDepth;
    s2 = vec2(ic.x, 0.0); len = ic.y;
    mask = 1.0 - smoothstep(1.92, 2.0, abs(ic.x));
  } else if (uProbe == 1){
    float R = 4.0; vec2 a = vec2(0.0, -R); vec2 rel = ic - a; float rho = length(rel); float th = atan(rel.x, rel.y);
    ok = abs(th) < 0.62 && rho >= R && rho - R <= uDepth;
    s2 = a + rel/rho*R; len = rho - R;
    mask = 1.0 - smoothstep(0.6, 0.62, abs(th));
  } else {
    float rho = length(ic); float th = atan(ic.x, ic.y);
    ok = abs(th) < 0.78 && rho <= uDepth && ic.y > 0.0;
    s2 = vec2(0.0); len = rho;
    mask = 1.0 - smoothstep(0.76, 0.78, abs(th));
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
    float edge = ok ? 1.0 - mask : 0.0;
    col = mix(col*(ok ? 1.0 : 0.35), vec3(0.3, 0.7, 1.0), edge);
    if (ic.y < 0.0) col *= 0.2;
    outColor = vec4(col, 1.0); return;
  }
  if (!ok){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Konvexe Sonde: Ankopplungsfläche liegt auf der Haut, nicht darüber
  float lift = uProbe == 1 ? 4.0 - 4.0*cos(atan(s2.x, s2.y + 4.0)) : 0.0;
  vec3 S = uOrigin + uRot*(vec3(s2.x, s2.y + lift, 0.0)*10.0);
  vec3 P = uOrigin + uRot*(vec3(ic.x, ic.y + lift, 0.0)*10.0);
  vec3 dir = normalize(P - S + uRot[1]*1e-4);
  float L = len*10.0;                      // mm
  float f = uProbe == 0 ? 7.5 : (uProbe == 1 ? 3.5 : 2.5);

  // Die Sonde drückt das Gewebe ein: Strahl beginnt am ersten Körpervoxel (bis 3 cm Luftspalt)
  float off = 0.0;
  for (int i = 0; i < 30; i++){
    if (classAt(S + dir*off) != AIR) break;
    off += 1.0;
  }
  if (off >= 30.0){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  gOff = off;
  P = at(S, dir, L);


  float att = 0.0, boneD = -1.0, gasD = -1.0, prev = 0.0;
  int before = SKIN;
  float stp = max(uDepth*10.0/90.0, 0.75);
  bool air = false;
  for (int i = 0; i < 140; i++){
    float s = (float(i)+0.5)*stp;
    if (s >= L) break;
    int c = classAt(moved(at(S, dir, s), s));
    int b = blocker(c);
    att += atten(c)*stp*0.1;
    if (b == 1 && boneD < 0.0) boneD = refine(S, dir, prev, s, 1);
    if (b == 2 && gasD < 0.0){ gasD = refine(S, dir, prev, s, 2); break; }
    if (b == 0) before = c;
    prev = s;
  }
  vec3 Pm = moved(P, L);
  int c = classAt(Pm);
  if (air){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float netDb = 0.6*f*(att - 0.6*min(len, 140.0*stp*0.1));
  float amp = pow(10.0, -netDb/20.0) * exp(-len*f*0.012);

  vec3 sp3 = Pm * (uProbe == 0 ? 2.2 : (uProbe == 1 ? 1.2 : 1.0));
  float n = 0.65*vnoise(sp3) + 0.35*vnoise(sp3*2.1 + 7.0);
  float speckle = mix(1.0, -log(1.0 - 0.98*n)*1.25, 0.8);

  float e = echo(c, Pm);
  // spiegelnde Grenzflächen (Kapseln, Zwerchfell, Gefäßwände, Blasenwand)
  int cb = classAt(moved(at(S, dir, L - 0.9), L - 0.9));
  if (!similar(c, cb) && blocker(c) == 0 && blocker(cb) == 0) e = max(e, 0.85);
  else if (c != cb && blocker(c) == 0 && blocker(cb) == 0) e = max(e, 0.5);

  if (boneD > 0.0 || blocker(c) == 1){
    float bd = boneD > 0.0 ? boneD : L;
    e = (L - bd < 2.5) ? 1.25 : 0.0;           // helle Knochenoberfläche
    if (L - bd >= 2.5) amp *= 0.04;            // Schallschatten
  }
  if (gasD > 0.0 || blocker(c) == 2){
    float g = gasD > 0.0 ? gasD : L;
    float d = L - g;
    bool lungWin = uWin >= 4;
    bool ptx = (uWin == 4 && (uCase & 16) != 0) || (uWin == 5 && (uCase & 32) != 0);
    bool mirror = before == LIVER || before == SPLEEN;   // Zwerchfell: Spiegelartefakt statt A-Linien
    float slideX = (lungWin && !ptx) ? breath()*3.5 : 0.0;
    vec3 sp = (P + uRot[0]*slideX) * 1.4;
    if (d < 1.4){
      e = 1.1*(0.7 + 0.5*vnoise(sp));
      speckle = 1.0;
    } else if (mirror){
      vec3 Q = moved(at(S, dir, g - d), g - d);
      e = 0.45*echo(classAt(Q), Q);
    } else {
      float m = max(round(L/g), 2.0);
      float u = (L - m*g)/0.9;
      float al = exp(-u*u) * pow(lungWin ? (ptx ? 0.62 : 0.52) : 0.35, m - 1.0);
      float shimmer = (lungWin && !ptx) ? 0.2*vnoise(sp*0.6 + vec3(0.0, 0.0, uTime*1.5))*exp(-d*0.3) : 0.0;
      e = 0.9*al + shimmer + 0.03*vnoise(sp);
      speckle = 1.0;
    }
  }

  float I = uGain * e * speckle * amp;
  float v = log(1.0 + 10.0*I) / log(11.0);
  v = clamp(v, 0.0, 1.0) * mask;
  vec3 col = vec3(v) * vec3(1.0, 0.99, 0.96);
  // Organe leicht einfärben, damit man erkennt, was was ist
  if (uTint == 1 && ((TINTMASK >> c) & 1) == 1 && boneD < 0.0 && gasD < 0.0){
    vec3 pc = PAL[c] / max(max(PAL[c].r, PAL[c].g), PAL[c].b);
    col = col*mix(vec3(1.0), pc, 0.35) + pc*0.05*mask;
  }
  outColor = vec4(col, 1.0);
}`;
