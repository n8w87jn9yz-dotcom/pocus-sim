// Rendert data/hold/<fenster>.webp aus tools/hold_render.html.
// Aufruf im Repo: python3 -m http.server 8766 & NODE_PATH=$(npm root -g) node tools/render_holds.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const port = process.env.PORT || 8766;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage();
  p.on('pageerror', e => console.error(e.message));
  await p.goto(`http://localhost:${port}/tools/hold_render.html`);
  await p.waitForFunction(() => window.ready);
  const out = await p.evaluate(() => window.renderAll());
  const dir = path.join(__dirname, '..', 'data', 'hold');
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, url] of Object.entries(out)) {
    fs.writeFileSync(path.join(dir, `${k}.webp`), Buffer.from(url.split(',')[1], 'base64'));
    console.log(k);
  }
  await b.close();
})();
