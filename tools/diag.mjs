/**
 * Visual diagnostics: boots the built game headlessly, generates an asylum
 * from a fixed seed, drives the camera into every room and a few set pieces,
 * and writes screenshots plus brightness stats of the finished frame.
 *
 *   npm run build && node tools/diag.mjs [seed] [--map=town]
 *
 * Shots land in tools/shots/<map>/.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const mapArg = process.argv.find((a) => a.startsWith('--map='));
const MAP = mapArg ? mapArg.slice(6) : 'asylum';
const SEED = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 4242);
const OUT = `tools/shots/${MAP}`;

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
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

await page.screenshot({ path: `${OUT}/menu.png` });

const plan = await page.evaluate(([seed, map]) => {
  const { game } = window.__RZA;
  const t0 = performance.now();
  game.newRun(seed, map);
  const buildMs = performance.now() - t0;
  game.input.locked = true;
  // Hide the HUD text overlays so the shots show the world.
  document.getElementById('banner').style.display = 'none';
  document.getElementById('toast').style.display = 'none';
  document.getElementById('click-to-play').style.display = 'none';
  const L = game.layout;
  window.__shot = (opts) => {
    const g = window.__RZA.game;
    if (opts.x !== undefined) {
      g.player.x = opts.x;
      g.player.z = opts.z;
    }
    if (opts.yaw !== undefined) g.player.yaw = opts.yaw;
    g.player.pitch = opts.pitch ?? 0;
    if (opts.openAll) {
      for (const d of g.props.doors) if (!d.open) g.buyDoor(d);
      g.player.award(90000);
    }
    if (opts.power) g.turnOnPower();
    if (opts.give) {
      for (const id of opts.give) g.player.giveWeapon(id);
      g.viewmodel.equip(g.player.slot.id);
    }
    if (opts.clear) g.pool.reset();
    if (opts.spawnAhead) {
      const fx = -Math.sin(g.player.yaw);
      const fz = -Math.cos(g.player.yaw);
      for (let i = 0; i < opts.spawnAhead; i++) {
        const e = g.pool.acquire(opts.kind ?? 'walker');
        if (!e) break;
        const side = (i % 3) - 1;
        const dist = 8 + Math.floor(i / 3) * 5;
        e.spawn(opts.kind ?? 'walker', g.player.x + fx * dist - fz * side * 3.2,
          g.player.z + fz * dist + fx * side * 3.2, 800, 6, null, g.rng);
        e.state = 'hunt';
      }
    }
    if (opts.freeze) for (const e of g.pool.all) if (e.active) e.speed = 0.01;
    for (let i = 0; i < (opts.frames ?? 20); i++) g.update(1 / 120);
    if (opts.reloadAt !== undefined) {
      // Freeze the view mid-reload, from an empty magazine.
      g.player.slot.mag = 0;
      g.startReload();
      const n = Math.round(g.player.reloadRemaining * opts.reloadAt * 120);
      for (let i = 0; i < n; i++) g.update(1 / 120);
    }
    g.player.health = g.player.maxHealth;
    g.damageFlash = 0;
    g.retro.setDamage(0);
    g.fadeIn = 1;
    g.retro.setFade(1);
    g.render();
    const f = g.retro.readFrame();
    let sum = 0;
    let dark = 0;
    for (let i = 0; i < f.pixels.length; i += 4) {
      const l = (f.pixels[i] + f.pixels[i + 1] + f.pixels[i + 2]) / 3;
      sum += l;
      if (l < 20) dark++;
    }
    const n = f.pixels.length / 4;
    return { mean: +(sum / n).toFixed(1), dark: Math.round((dark / n) * 100) };
  };
  // One shot per room: stand in a corner, look at the far corner.
  const rooms = L.zones.map((z) => {
    const r = z.rect;
    const x = (r.x + 1.2) * 4;
    const zz = (r.z + 1.2) * 4;
    const tx = (r.x + r.w - 1) * 4;
    const tz = (r.z + r.h - 1) * 4;
    return { name: `${z.theme}`, x, z: zz, yaw: Math.atan2(-(tx - x), -(tz - zz)) };
  });
  const b = L.barricades.find((w) => w.zone === L.spawnZone);
  const inside = { x: (b.tx - b.dx * 3 + 0.5) * 4, z: (b.tz - b.dz * 3 + 0.5) * 4 };
  return {
    buildMs: Math.round(buildMs),
    seed: L.seed,
    spawn: { x: game.player.x, z: game.player.z, yaw: game.player.yaw },
    rooms,
    window: { ...inside, yaw: Math.atan2(-b.dx, -b.dz), b },
  };
}, [SEED, MAP]);

console.log(`${MAP} seed ${plan.seed}: world built in ${plan.buildMs} ms`);

const shots = [
  ['spawn', { ...plan.spawn, frames: 30 }],
  ...plan.rooms.map((r, i) => [`room${i}-${r.name}`, { x: r.x, z: r.z, yaw: r.yaw, openAll: i === 0, power: i === 0, frames: 10 }]),
  ['window', { x: plan.window.x, z: plan.window.z, yaw: plan.window.yaw, frames: 10 }],
  ['zombies', { ...plan.spawn, clear: true, spawnAhead: 6, frames: 40, freeze: true }],
  ['hounds', { ...plan.spawn, clear: true, spawnAhead: 4, kind: 'hound', frames: 40, freeze: true }],
  ['shotgun', { ...plan.spawn, clear: true, give: ['boomstick'], spawnAhead: 3, frames: 60, freeze: true }],
  ['reload', { ...plan.spawn, clear: true, give: ['nailrifle'], spawnAhead: 3, frames: 60, freeze: true, reloadAt: 0.2 }],
];

for (const [name, opts] of shots) {
  const stats = await page.evaluate((o) => window.__shot(o), opts);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name.padEnd(22)} mean ${String(stats.mean).padStart(6)}   near-black ${String(stats.dark).padStart(3)}%`);
}

await browser.close();
server.close();
