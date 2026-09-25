/**
 * Visual diagnostics: boots the built game headlessly, drives it into a few
 * situations and writes screenshots plus raw-buffer brightness stats.
 * Usage: npm run build && node tools/diag.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    let p = new URL(req.url, 'http://l').pathname;
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p.split('/').filter(Boolean).join('/'));
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404).end('x');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

await page.evaluate(() => {
  const { game } = window.__RZA;
  window.__shot = (opts) => {
    const g = window.__RZA.game;
    if (opts.reset) {
      g.newRun();
      g.input.locked = true;
    }
    if (opts.tile) {
      g.player.x = (opts.tile[0] + 0.5) * 4;
      g.player.z = (opts.tile[1] + 0.5) * 4;
    }
    if (opts.yaw !== undefined) g.player.yaw = opts.yaw;
    if (opts.pitch !== undefined) g.player.pitch = opts.pitch;
    if (opts.openAll) {
      for (const d of g.props.doors) g.buyDoor(d);
      g.player.award(90000);
    }
    if (opts.power) g.turnOnPower();
    for (let i = 0; i < (opts.frames ?? 20); i++) g.update(1 / 120);
    g.fadeIn = 1;
    g.retro.setFade(1);
    g.render();
    const f = g.retro.readFrame();
    let min = 255;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < f.pixels.length; i += 4) {
      const l = (f.pixels[i] + f.pixels[i + 1] + f.pixels[i + 2]) / 3;
      if (l < min) min = l;
      if (l > max) max = l;
      sum += l;
    }
    return { min, max: Math.round(max), mean: +(sum / (f.pixels.length / 4)).toFixed(1) };
  };
  game.newRun();
  game.input.locked = true;
});

const shots = [
  ['lobby-spawn', { reset: true, yaw: Math.PI, frames: 60 }],
  ['lobby-desk', { tile: [24, 33], yaw: Math.PI, pitch: 0.05, frames: 20 }],
  ['chapel', { openAll: true, power: true, tile: [24, 14], yaw: Math.PI, frames: 30 }],
  ['furnace', { tile: [7, 30], yaw: -Math.PI / 2, frames: 20 }],
  ['generator', { tile: [40, 10], yaw: Math.PI / 2, frames: 20 }],
  ['catacombs', { tile: [8, 10], yaw: 0, frames: 20 }],
  ['horde', { tile: [24, 31], yaw: Math.PI, frames: 60 * 22 }],
];

for (const [name, opts] of shots) {
  const stats = await page.evaluate((o) => window.__shot(o), opts);
  await page.screenshot({ path: `tools/shots/${name}.png` });
  console.log(`${name.padEnd(14)} mean ${String(stats.mean).padStart(6)}  max ${String(stats.max).padStart(4)}  min ${stats.min}`);
}

await browser.close();
server.close();
