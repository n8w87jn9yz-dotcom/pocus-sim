// Ultraschallbild in eigenem WebGL2-Kontext, für die Quest-Version (xr.html).
// Gleicher Shader und gleiche Volumen wie der Monitor (index.html); das Bild landet in einer Canvas,
// die xr.js als Textur auf das virtuelle Gerät legt. Laden der Volumen wie fetchVolume() in monitor.js.
import { VERT, FRAG } from './shader.js';
import { PROBES } from './common.js';
import { buildFields, buildHeart } from './fields.js';

const UNIFORMS = ['uRes', 'uDepth', 'uGain', 'uTime', 'uTop', 'uProbe', 'uWin', 'uCase', 'uOrigin', 'uRot', 'uVol',
  'uDims', 'uSpacing', 'uDebug', 'uTint', 'uSm', 'uBlk', 'uHrt', 'uHC', 'uHAx'];

export class UltrasoundRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('Kein WebGL2');
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.U = {};
    for (const n of UNIFORMS) this.U[n] = gl.getUniformLocation(prog, n);
    // GPU-Zeit je Bild, wenn der Browser Zeitmessung erlaubt (auf der Quest meist ja)
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.query = null;
    this.gpuMs = null;
  }

  async loadVolume(name) {
    const gl = this.gl;
    const meta = await (await fetch(`data/${name}/meta.json`)).json();
    let buf = new Uint8Array(await (await fetch(`data/${name}/vol.bin.gz`)).arrayBuffer());
    // Manche Server entpacken .gz bereits selbst, dann fehlt die gzip-Signatur
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const [dx, dy, dz] = meta.dims;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8UI, dx, dy, dz, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, buf);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    const { A, B } = buildFields(buf, meta.dims);
    const smooth = (fmt, ifmt, arr, w = dx, h = dy, d = dz) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texImage3D(gl.TEXTURE_3D, 0, ifmt, w, h, d, 0, fmt, gl.UNSIGNED_BYTE, arr);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      return t;
    };
    const sm = smooth(gl.RGBA, gl.RGBA8, A), blk = smooth(gl.RGBA, gl.RGBA8, B);
    // Herzfeld nur, wenn das Volumen ein Herz enthält; sonst ein leeres 1x1x1-Feld (Herz weit weg)
    const h = buildHeart(buf, meta.dims, meta.spacing);
    const hrt = h ? smooth(gl.RG, gl.RG8, h.tex) : smooth(gl.RG, gl.RG8, new Uint8Array([0, 0]), 1, 1, 1);
    return {
      name, meta, data: buf, tex, sm, blk, hrt,
      offset: meta.offset || [0, 0, 0],
      heart: h ? { c: h.center, ax: h.axis } : { c: [0, 0, 0], ax: [0, 0, 1] },
    };
  }

  classAt(vol, p) {
    const [dx, dy, dz] = vol.meta.dims, s = vol.meta.spacing;
    const x = Math.floor(p[0] / s), y = Math.floor(p[1] / s), z = Math.floor(p[2] / s);
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return 0;
    return vol.data[4 * (x + dx * (y + dy * z))];
  }

  // Erster Gewebepunkt entlang D ab p - back*D, in 1-mm-Schritten (wie probeOrigin() in monitor.js).
  // Rückgabe: Hautpunkt und Abstand (mm) vom Startpunkt, oder null.
  skin(vol, p, D, back = 80, steps = 200) {
    for (let i = 0; i < steps; i++) {
      const q = [0, 1, 2].map(k => p[k] + D[k] * (i - back));
      if (this.classAt(vol, q) !== 0) return { p: q, at: i - back };
    }
    return null;
  }

  clear() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // s: { probe, depth, gain, time, win, cases, tint }, M Spalten lateral/Tiefe/Elevation, o Hautpunkt (mm, Volumen)
  draw(vol, M, o, s) {
    const gl = this.gl, U = this.U;
    this.readTimer();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const tex = [vol.tex, vol.sm, vol.blk, vol.hrt], names = ['uVol', 'uSm', 'uBlk', 'uHrt'];
    tex.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.uniform1i(U[names[i]], i);
    });
    gl.uniform3f(U.uHC, ...vol.heart.c);
    gl.uniform3f(U.uHAx, ...vol.heart.ax);
    gl.uniform3f(U.uDims, ...vol.meta.dims);
    gl.uniform1f(U.uSpacing, vol.meta.spacing);
    gl.uniform1i(U.uDebug, 0);
    gl.uniform1i(U.uTint, s.tint ? 1 : 0);
    gl.uniform2f(U.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(U.uDepth, s.depth);
    gl.uniform1f(U.uGain, s.gain);
    gl.uniform1f(U.uTime, s.time);
    gl.uniform1f(U.uTop, s.probe === 'convex' ? 0.9 : 0.15);
    gl.uniform1i(U.uProbe, PROBES[s.probe].id);
    gl.uniform1i(U.uWin, s.win);
    gl.uniform1i(U.uCase, s.cases);
    gl.uniform3f(U.uOrigin, ...o);
    // spaltenweise: lateral, Tiefe, Elevation
    gl.uniformMatrix3fv(U.uRot, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
    if (this.timer && !this.query) {
      this.query = gl.createQuery();
      gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.query);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    } else gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  readTimer() {
    const gl = this.gl, q = this.query;
    if (!q || !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      this.gpuMs = this.gpuMs == null ? ms : this.gpuMs * 0.9 + ms * 0.1;
    }
    gl.deleteQuery(q);
    this.query = null;
  }
}
