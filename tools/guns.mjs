/**
 * Weapon contact sheets: for every gun, the hip pose, aiming down the sights,
 * and four moments of its reload, rendered by the real game and tiled into one
 * image per weapon under tools/shots/guns/.
 *
 *   npm run build && node tools/guns.mjs [weaponId ...]
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const ALL = ['sidearm', 'boomstick', 'trench', 'grease', 'nailrifle', 'longshot', 'scattergun', 'ripper', 'plasma', 'hellfire', 'thunder', 'stormcaller', 'wintershowl', 'dragonfire'];
const args = process.argv.slice(2).filter((a) => !a.startsWith('--tier='));
const TIER_ARG = Number((process.argv.find((a) => a.startsWith('--tier=')) ?? '--tier=0').slice(7));
const ids = args.length ? args : ALL;

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
await mkdir('tools/shots/guns', { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

for (const id of ids) {
  const url = await page.evaluate(async ({ weapon, TIER }) => {
    const g = window.__RZA.game;
    g.newRun(4242);
    g.input.locked = true;
    for (const n of ['hud']) document.getElementById(n).style.display = 'none';
    g.pool.reset();
    g.roundPhase = 'clear';
    g.phaseTimer = 999;
    g.player.slots = [{ id: weapon, mag: 0, reserve: 500, tier: TIER, mod: null }];
    g.player.activeSlot = 0;
    g.equipCurrent();
    // Face a lit wall of the start room.
    const L = g.layout;
    const z = L.zones.find((q) => q.id === L.spawnZone);
    g.player.x = (z.rect.x + z.rect.w / 2) * 4;
    g.player.z = (z.rect.z + z.rect.h / 2) * 4;
    g.player.yaw = 0.6;
    g.player.pitch = -0.05;
    const step = (sec) => {
      const n = Math.max(1, Math.round(sec * 120));
      for (let i = 0; i < n; i++) g.update(1 / 120);
    };
    const tiles = [];
    const grab = (label) => {
      g.player.health = g.player.maxHealth;
      g.retro.setDamage(0);
      g.retro.setFade(1);
      g.render();
      const c = document.createElement('canvas');
      c.width = 480;
      c.height = 300;
      const x = c.getContext('2d');
      x.drawImage(g.retro.renderer.domElement, 0, 0, 480, 300);
      x.fillStyle = 'rgba(0,0,0,0.6)';
      x.fillRect(0, 0, 480, 20);
      x.fillStyle = '#ffd84d';
      x.font = '14px monospace';
      x.fillText(`${weapon}  ${label}`, 6, 15);
      tiles.push(c);
    };
    step(0.6);
    g.player.slot.mag = 3;
    grab('hip');
    g.input.aim = true;
    step(0.5);
    grab('aim');
    g.input.aim = false;
    step(0.4);
    // Reload from empty so the whole performance plays.
    g.player.slot.mag = 0;
    g.startReload();
    const dur = g.player.reloadRemaining;
    const marks = [0.2, 0.42, 0.66, 0.84];
    let t = 0;
    for (const m of marks) {
      step(dur * m - t);
      t = dur * m;
      grab(`reload ${Math.round(m * 100)}%`);
    }
    const sheet = document.createElement('canvas');
    sheet.width = 1440;
    sheet.height = 600;
    const sx = sheet.getContext('2d');
    tiles.forEach((c, i) => sx.drawImage(c, (i % 3) * 480, Math.floor(i / 3) * 300));
    return sheet.toDataURL('image/png');
  }, { weapon: id, TIER: TIER_ARG });
  await writeFile(`tools/shots/guns/${id}${TIER_ARG ? `-tier${TIER_ARG}` : ''}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`wrote tools/shots/guns/${id}.png`);
}

await browser.close();
server.close();
