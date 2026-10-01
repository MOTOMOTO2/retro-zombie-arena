/**
 * Contact sheet of every kind of enemy, standing in the same room at the same
 * camera, so a new one can be eyeballed against the rest of the crowd.
 *
 *   npm run build && node tools/lineup.mjs
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
    res.writeHead(404).end('no');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

const url = await page.evaluate(() => {
  const g = window.__RZA.game;
  document.getElementById('hud').style.display = 'none';
  const tiles = [];
  const shot = (label, kinds, pitch = -0.1, out = 9) => {
    g.newRun(4242);
    g.input.locked = true;
    g.pool.reset();
    g.roundPhase = 'clear';
    g.phaseTimer = 1e9;
    const L = g.layout;
    const room = L.zones.find((z) => z.id === L.spawnZone);
    g.player.x = (room.rect.x + 1.5) * 4;
    g.player.z = (room.rect.z + room.rect.h / 2) * 4;
    g.player.yaw = -Math.PI / 2;
    g.player.pitch = pitch;
    kinds.forEach((kind, i) => {
      const e = g.pool.acquire(kind);
      if (!e) return;
      e.spawn(kind, g.player.x + out, g.player.z - 3 + i * 3, 4000, 12, null, g.rng, 0);
      e.state = 'hunt';
      e.speed = 0.01;
      e.yaw = -Math.PI / 2;
    });
    for (let i = 0; i < 40; i++) {
      g.player.health = g.player.maxHealth;
      g.update(1 / 120);
    }
    g.render();
    const f = g.retro.readFrame();
    const c = document.createElement('canvas');
    c.width = f.width;
    c.height = f.height;
    const cx = c.getContext('2d');
    const img = cx.createImageData(f.width, f.height);
    img.data.set(f.pixels);
    // readFrame comes back bottom-up.
    cx.putImageData(img, 0, 0);
    cx.save();
    cx.scale(1, -1);
    cx.drawImage(c, 0, -f.height);
    cx.restore();
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, 210, 18);
    cx.fillStyle = '#9f9';
    cx.font = '13px monospace';
    cx.fillText(label, 5, 13);
    tiles.push(c);
  };

  shot('walker / tank / brute', ['walker', 'tank', 'brute']);
  shot('tank alone', ['tank']);
  shot('crawler, close, looking down', ['crawler'], -0.45, 5);
  shot('crawler beside a walker', ['crawler', 'walker'], -0.3, 6);

  const w = tiles[0].width;
  const h = tiles[0].height;
  const sheet = document.createElement('canvas');
  sheet.width = w * 2;
  sheet.height = h * 2;
  const sx = sheet.getContext('2d');
  tiles.forEach((c, i) => sx.drawImage(c, (i % 2) * w, Math.floor(i / 2) * h));
  return sheet.toDataURL('image/png');
});
await mkdir('tools/shots', { recursive: true });
await writeFile('tools/shots/lineup.png', Buffer.from(url.split(',')[1], 'base64'));
console.log('wrote tools/shots/lineup.png');
await browser.close();
server.close();
