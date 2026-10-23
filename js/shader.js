// Fragment-Shader: erzeugt das B-Bild aus einer prozeduralen Anatomie.
// Szenenkoordinaten in cm: x = lateral (Markerseite negativ), y = Tiefe ab Haut, z = Elevation.
// Pro Pixel wird der Schallstrahl von der Sonde bis zum Bildpunkt abgetastet
// (Dämpfung, Schallschatten hinter Knochen, Reverberation hinter Gas).

export const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDepth, uGain, uTime, uTop;
uniform int uProbe, uWin, uCase;
uniform vec3 uOrigin;
uniform mat3 uRot;
out vec4 outColor;

struct Tis { float e; float a; int b; }; // Echogenität, Dämpfung, 0 Gewebe / 1 Knochen / 2 Gas / 3 Luft
Tis T(float e, float a, int b){ Tis t; t.e = e; t.a = a; t.b = b; return t; }

float hash(vec3 p){ p = fract(p*0.3183099 + vec3(.1,.2,.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float sdE(vec3 p, vec3 r){ float k0 = length(p/r); float k1 = length(p/(r*r)); return k0*(k0-1.0)/max(k1, 1e-4); }
float breath(){ return sin(uTime*6.2832/4.0); }
float systole(){ float ph = fract(uTime/0.9); return smoothstep(0.0,0.15,ph)*(1.0-smoothstep(0.35,0.6,ph)); }
float tex(vec3 p, float s){ return 0.6 + 0.8*vnoise(p*s); }

// Brustwand/Bauchwand: Haut, Fett mit Septen, Muskel
Tis wall(vec3 p){
  float y = p.y;
  if (y < -1.0) return T(0.0, 0.0, 3);
  if (y < 0.2) return T(0.7, 0.6, 0);
  if (y < 1.1) return T(0.15 + 0.55*step(0.86, vnoise(p*vec3(1.5,9.0,1.5))), 0.6, 0);
  if (y < 1.2) return T(0.8, 0.6, 0);
  if (y < 2.0) return T(0.36 + 0.16*sin(y*28.0 + vnoise(p*2.0)*3.0), 0.9, 0);
  if (y < 2.1) return T(0.75, 0.6, 0);
  return T(0.42*tex(p, 0.5), 0.7, 0);
}

Tis liverTex(vec3 bp, float dL){
  float pv = min(min(length(bp.xy-vec2(-3.0,6.5)), length(bp.xy-vec2(0.5,9.0))), length(bp.xy-vec2(-5.0,9.5)));
  if (pv < 0.45) return T(0.02, 0.05, 0);
  if (pv < 0.58) return T(0.9, 0.6, 0);
  if (dL > -0.07) return T(0.85, 0.6, 0);
  return T(0.5*tex(bp, 0.9), 0.55, 0);
}

Tis kidneyTex(vec3 kp, float dK, float dS){
  if (dK > -0.08) return T(0.9, 0.6, 0);
  if (dS < 0.0) return T(0.8*tex(kp, 2.0), 0.6, 0);
  return T(0.36, 0.6, 0);
}

Tis ruq(vec3 p, bool fluid){
  Tis t = wall(p);
  if (t.b == 3) return t;
  if (length(p.xy-vec2(-3.4,1.9)) < 0.7 || length(p.xy-vec2(3.6,1.9)) < 0.7) return T(1.0, 4.0, 1);
  if (p.y < 2.1) return t;
  vec3 bp = p; bp.x += breath()*0.6;
  float dL = sdE(bp-vec3(-1.0,7.5,0.0), vec3(7.5,5.5,7.0));
  float dD = length(bp-vec3(-11.0,9.0,0.0)) - 6.5;
  vec3 kp = bp-vec3(4.0,10.0,0.0); kp.xy = mat2(0.94,-0.34,0.34,0.94)*kp.xy;
  float dK = sdE(kp, vec3(4.5,2.2,2.6));
  float dS = sdE(kp, vec3(2.6,0.9,1.3));
  if (abs(dD) < 0.18 && dL < 1.0) return T(1.0, 0.6, 0);
  if (dD < 0.0) return T(0.3*tex(bp, 0.6), 0.6, 0);                 // Spiegelartefakt über dem Zwerchfell
  if (fluid && dK > 0.0 && dK < 0.8 && dL < 0.6 && kp.y < 0.6) return T(0.0, 0.05, 0); // freie Flüssigkeit im Morison-Pouch
  if (dK < 0.0) return kidneyTex(kp, dK, dS);
  if (dL < 0.0) return liverTex(bp, dL);
  return T(0.42*tex(bp, 0.5), 0.7, 0);
}

Tis luq(vec3 p, bool fluid){
  Tis t = wall(p);
  if (t.b == 3) return t;
  if (length(p.xy-vec2(-3.0,1.9)) < 0.7 || length(p.xy-vec2(3.2,1.9)) < 0.7) return T(1.0, 4.0, 1);
  if (p.y < 2.1) return t;
  vec3 bp = p; bp.x += breath()*0.5;
  float dSp = sdE(bp-vec3(-2.0,5.8,0.0), vec3(5.0,3.0,4.0));
  float dD = length(bp-vec3(-10.0,6.5,0.0)) - 6.0;
  vec3 kp = bp-vec3(3.5,9.0,0.0); kp.xy = mat2(0.94,0.34,-0.34,0.94)*kp.xy;
  float dK = sdE(kp, vec3(4.3,2.1,2.5));
  float dS = sdE(kp, vec3(2.5,0.85,1.2));
  if (abs(dD) < 0.18 && dSp < 1.5) return T(1.0, 0.6, 0);
  if (dD < 0.0) return T(0.28*tex(bp, 0.6), 0.6, 0);
  if (fluid && dK > 0.0 && ((dSp > 0.0 && dSp < 0.7 && bp.y > 5.0) || (dD > 0.0 && dD < 0.6 && dSp < 1.0))) return T(0.0, 0.05, 0); // splenorenal / subphrenisch
  if (dSp < 0.0) return T(dSp > -0.07 ? 0.85 : 0.52*tex(bp, 1.0), 0.55, 0);
  if (dK < 0.0) return kidneyTex(kp, dK, dS);
  return T(0.42*tex(bp, 0.5), 0.7, 0);
}

Tis subx(vec3 p, bool eff){
  Tis t = wall(p);
  if (t.b == 3) return t;
  if (p.y < 2.1) return t;
  float dLv = sdE(p-vec3(-3.5,3.4,0.0), vec3(8.0,3.0,7.0));
  if (dLv < 0.0) return T(dLv > -0.07 ? 0.85 : 0.5*tex(p, 0.9), 0.55, 0);
  vec3 hp = p-vec3(1.5,10.5,0.0); hp.xy = mat2(0.9,0.44,-0.44,0.9)*hp.xy;
  float dH = sdE(hp, vec3(5.3,3.4,4.0));
  float dP = dH - (eff ? 0.8 : 0.15);
  if (abs(dP) < 0.15) return T(1.0, 0.6, 0);                       // Perikard
  if (eff && dP < 0.0 && dH > 0.0) return T(0.0, 0.05, 0);          // Perikarderguss
  if (dH < 0.0){
    float s = systole(), k = 1.0 - 0.14*s, ka = 1.0 + 0.1*s;
    float rv = sdE(hp-vec3(1.0,-1.6,0.0), vec3(3.4,1.25,2.4)*k);
    float lv = sdE(hp-vec3(1.3,1.0,0.0), vec3(3.6,1.5,2.4)*k);
    float ra = sdE(hp-vec3(-3.1,-1.3,0.0), vec3(1.6,1.2,2.0)*ka);
    float la = sdE(hp-vec3(-3.1,1.4,0.0), vec3(1.6,1.2,2.0)*ka);
    if (min(min(rv,lv), min(ra,la)) < 0.0) return T(0.02, 0.08, 0);
    return T(0.55*tex(hp, 1.5), 0.6, 0);
  }
  return T(0.42*tex(p, 0.5), 0.7, 0);
}

Tis pelv(vec3 p, bool fluid){
  Tis t = wall(p);
  if (t.b == 3) return t;
  if (p.y < 2.1) return t;
  if (length(p.xy-vec2(-7.0,9.5)) < 1.6 || length(p.xy-vec2(7.0,9.5)) < 1.6) return T(1.0, 4.0, 1);
  float dB = sdE(p-vec3(0.0,5.4,0.0), vec3(4.6,3.0,4.0));
  float dU = sdE(p-vec3(0.0,9.8,0.0), vec3(3.0,2.0,3.0));
  if (abs(dB) < 0.12) return T(0.9, 0.6, 0);
  if (dB < 0.0) return T(0.0, 0.03, 0);
  if (dU < 0.0) return T(dU > -0.08 ? 0.6 : 0.4*tex(p, 2.0), 0.6, 0);
  if (fluid && p.y > 7.0 && sdE(p-vec3(0.0,9.4,0.0), vec3(5.5,3.0,4.0)) < 0.0) return T(0.0, 0.05, 0);
  if (p.y > 11.0 && vnoise(p*0.6) > 0.78) return T(0.9, 0.6, 2);   // Darmgas
  return T(0.42*tex(p, 0.5), 0.7, 0);
}

Tis lung(vec3 p){
  Tis t = wall(p);
  if (t.b == 3) return t;
  if (length(vec2(mod(p.x, 4.2)-2.1, p.y-1.15)) < 0.55) return T(1.0, 4.0, 1); // Rippen
  if (p.y > 1.55) return T(0.9, 0.6, 2);                                     // Pleura, dahinter Luft
  return t;
}

Tis tissue(vec3 p){
  if (uWin == 0) return ruq(p, (uCase & 1) != 0);
  if (uWin == 1) return luq(p, (uCase & 2) != 0);
  if (uWin == 2) return subx(p, (uCase & 4) != 0);
  if (uWin == 3) return pelv(p, (uCase & 8) != 0);
  return lung(p);
}

// Grenzfläche zwischen a (davor) und b (Treffer) per Bisektion verfeinern
float refine(vec3 S, vec3 dir, float a, float b, int kind){
  for (int i = 0; i < 6; i++){
    float m = 0.5*(a+b);
    if (tissue(S+dir*m).b == kind) b = m; else a = m;
  }
  return b;
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float sc = uRes.y / (uDepth + uTop);
  vec2 ic = vec2((px.x - 0.5*uRes.x)/sc, px.y/sc - uTop);

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
  if (!ok){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 S = uOrigin + uRot*vec3(s2, 0.0);
  vec3 P = uOrigin + uRot*vec3(ic, 0.0);
  vec3 dir = normalize(P - S + vec3(0.0, 1e-5, 0.0));
  float f = uProbe == 0 ? 7.5 : (uProbe == 1 ? 3.5 : 2.5);

  float att = 0.0, boneD = -1.0, gasD = -1.0, prev = 0.0;
  float stp = max(uDepth/80.0, 0.05);
  bool air = false;
  for (int i = 0; i < 100; i++){
    float s = (float(i)+0.5)*stp;
    if (s >= len) break;
    Tis q = tissue(S + dir*s);
    if (q.b == 3){ air = true; break; }
    att += q.a*stp;
    if (q.b == 1 && boneD < 0.0) boneD = refine(S, dir, prev, s, 1);
    if (q.b == 2 && gasD < 0.0){ gasD = refine(S, dir, prev, s, 2); break; }
    prev = s;
  }
  Tis q = tissue(P);
  if (air || q.b == 3){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Dämpfung relativ zur Tiefenausgleichskurve (TGC geht von 0,6 dB/cm/MHz aus)
  float netDb = 0.6*f*(att - 0.6*min(len, float(100)*stp));
  float amp = pow(10.0, -netDb/20.0) * exp(-len*f*0.012);

  vec3 sp3 = P * (uProbe == 0 ? 22.0 : (uProbe == 1 ? 12.0 : 10.0));
  float n = 0.65*vnoise(sp3) + 0.35*vnoise(sp3*2.1 + 7.0);
  float speckle = mix(1.0, -log(1.0 - 0.98*n)*1.25, 0.8);

  float e = q.e;
  if (boneD > 0.0 || q.b == 1){
    float bd = boneD > 0.0 ? boneD : len;
    e = (len - bd < 0.25) ? 1.25 : 0.0;           // helle Knochenoberfläche
    if (len - bd >= 0.25) amp *= 0.04;           // Schallschatten
  }
  if (gasD > 0.0 || q.b == 2){
    float g = gasD > 0.0 ? gasD : len;
    float d = len - g;
    bool ptx = (uWin == 4 && (uCase & 16) != 0) || (uWin == 5 && (uCase & 32) != 0);
    bool lungWin = uWin >= 4;
    float slideX = (lungWin && !ptx) ? breath()*0.35 : 0.0;
    vec3 sp = vec3(P.x + slideX, P.y, P.z) * 14.0;
    if (d < 0.14){
      e = 1.1 * (0.7 + 0.5*vnoise(sp));          // Pleuralinie bzw. Gasgrenze
    } else {
      float m = max(round(len/g), 2.0);
      float u = (len - m*g)/0.09;
      float al = exp(-u*u) * pow(lungWin ? (ptx ? 0.62 : 0.52) : 0.4, m - 1.0);
      float shimmer = (lungWin && !ptx) ? 0.2*vnoise(sp*0.6 + vec3(0.0, 0.0, uTime*1.5))*exp(-d*3.0) : 0.0;
      e = 0.9*al + shimmer + 0.03*vnoise(sp);    // A-Linien, Lungengleiten
    }
    speckle = 1.0;
  }

  float I = uGain * e * speckle * amp;
  float v = log(1.0 + 10.0*I) / log(11.0);
  v = clamp(v, 0.0, 1.0) * mask;
  outColor = vec4(vec3(v) * vec3(1.0, 0.99, 0.96), 1.0);
}`;
