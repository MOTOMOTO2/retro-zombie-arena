/**
 * Contact sheet of the horde's hit reactions and deaths: a flinch, each kind
 * of fall caught mid-way and on the floor, and a headshot kill.
 *
 *   npm run build && node tools/deaths.mjs
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
    res.writeHead(404).end('x');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir('tools/shots', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

const url = await page.evaluate(() => {
  const g = window.__RZA.game;
  const tiles = [];
  document.getElementById('hud').style.display = 'none';
  // Each scene: a fresh zombie standing in front of the camera, hit a certain
  // way, then the clock run forward before the frame is grabbed.
  const scene = (label, hit, after) => {
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
    g.player.pitch = -0.22;
    const e = g.pool.acquire('walker');
    e.spawn('walker', g.player.x + 5.5, g.player.z, 400, 3, null, g.rng);
    e.state = 'hunt';
    e.speed = 0.01;
    for (let i = 0; i < 30; i++) g.update(1 / 60);
    hit(e);
    const n = Math.round(after * 120);
    for (let i = 0; i < n; i++) {
      g.player.health = g.player.maxHealth;
      g.update(1 / 120);
    }
    g.retro.setDamage(0);
    g.retro.setFade(1);
    g.render();
    const c = document.createElement('canvas');
    c.width = 426;
    c.height = 266;
    const x = c.getContext('2d');
    x.drawImage(g.retro.renderer.domElement, 160, 60, 640, 400, 0, 0, 426, 266);
    x.fillStyle = 'rgba(0,0,0,0.6)';
    x.fillRect(0, 0, 426, 18);
    x.fillStyle = '#ffd84d';
    x.font = '13px monospace';
    x.fillText(label, 6, 13);
    tiles.push(c);
  };
  const shot = (dmg, head = false) => (e) => g.damageEnemy(e, dmg, head, false, new THREE_V(e));
  // A stand-in for THREE.Vector3 - damageEnemy only reads x, y, z.
  function THREE_V(e) {
    this.x = e.x;
    this.y = e.headY - 1;
    this.z = e.z;
  }
  const kill = (kind) => (e) => {
    g.damageEnemy(e, 450, false, false, new THREE_V(e));
    e.deathKind = kind;
  };
  scene('standing', () => {}, 0.1);
  scene('flinch (body hit)', shot(120), 0.07);
  scene('head snap (headshot)', shot(120, true), 0.07);
  scene('fall back  0.35s', kill('back'), 0.35);
  scene('fall back  landed', kill('back'), 1.2);
  scene('face-plant 0.5s', kill('forward'), 0.5);
  scene('face-plant landed', kill('forward'), 1.3);
  scene('crumple 0.35s', kill('crumple'), 0.35);
  scene('crumple landed', kill('crumple'), 1.4);
  scene('headshot kill', (e) => g.damageEnemy(e, 900, true, false, new THREE_V(e)), 0.25);
  scene('explosion 0.25s', (e) => g.explode(e.x + 3, 1, e.z, 8, 2000), 0.25);
  scene('explosion landed', (e) => g.explode(e.x + 3, 1, e.z, 8, 2000), 1.2);
  const sheet = document.createElement('canvas');
  sheet.width = 1704;
  sheet.height = 798;
  const sx = sheet.getContext('2d');
  tiles.forEach((c, i) => sx.drawImage(c, (i % 4) * 426, Math.floor(i / 4) * 266));
  return sheet.toDataURL('image/png');
});
await writeFile('tools/shots/deaths.png', Buffer.from(url.split(',')[1], 'base64'));
console.log('wrote tools/shots/deaths.png');
await browser.close();
server.close();
