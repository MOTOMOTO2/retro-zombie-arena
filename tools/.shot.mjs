import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg' };
const server = createServer(async (req, res) => {
  try {
    let p = new URL(req.url, 'http://l').pathname;
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p.split('/').filter(Boolean).join('/'));
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404).end('x'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await mkdir('tools/shots/review', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA), null, { timeout: 30000 });

// The controls panel.
await page.evaluate(() => {
  document.getElementById('btn-settings').click();
  document.getElementById('btn-controls').click();
});
await page.screenshot({ path: 'tools/shots/review/controls.png' });

// Mid-rebind, so the lit-up row shows.
await page.evaluate(() => {
  [...document.querySelectorAll('#key-rows .bind')]
    .find((r) => r.querySelector('span').textContent === 'GRENADE').querySelector('button').click();
});
await page.screenshot({ path: 'tools/shots/review/controls-listening.png' });

// The damage wedge, in game, from behind-right.
await page.evaluate(() => {
  const { game } = window.__RZA;
  document.getElementById('btn-controls-back').click();
  document.getElementById('btn-settings-back').click();
  game.hostPresents = false;
  game.newRun(4242, 'asylum');
  game.input.locked = true;
  game.player.award(1e6);
  game.startRound(4);
  for (let i = 0; i < 900; i++) { game.player.health = 1e9; game.update(1 / 120); }
  const p = game.player;
  p.yaw = 0;
  p.health = p.maxHealth * 0.55;
  // Behind and to the right: the wedge should sit low-right of the crosshair.
  game.hurtPlayer(10, { x: p.x + 8, z: p.z + 8 });
  game.present(1 / 60);
  game.render();
});
await page.screenshot({ path: 'tools/shots/review/damage-wedge.png' });
console.log('wrote tools/shots/review/');
await browser.close();
server.close();
