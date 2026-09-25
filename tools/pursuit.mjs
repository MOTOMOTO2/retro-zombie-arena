/**
 * Pursuit stress test: opens every door, scatters zombies over the whole
 * asylum, stands an invulnerable player in the start room and measures how
 * many of the horde reach them, and how fast, over several seeds.
 *
 *   npm run build && node tools/pursuit.mjs [seconds]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const SECONDS = Number(process.argv[2] ?? 40);
// --pure switches recycling off, to measure pathing on its own.
const PURE = process.argv.includes('--pure');
const SEEDS = [4242, 7, 90210, 1234, 555];

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
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

for (const seed of SEEDS) {
  const r = await page.evaluate(({ seed, seconds, pure }) => {
    const g = window.__RZA.game;
    g.newRun(seed);
    g.input.locked = true;
    g.pool.reset();
    g.player.award(1e6);
    for (const d of g.props.doors) if (!d.open) g.buyDoor(d);
    if (g.props.doors.some((d) => !d.open)) throw new Error("a door stayed shut");
    for (let i = 0; i < 200; i++) g.update(1 / 60);
    // Keep the round from spawning anything else.
    g.roundPhase = 'clear';
    g.phaseTimer = 1e9;
    const L = g.layout;
    const floor = [];
    for (let i = 0; i < L.tiles.length; i++) if (L.tiles[i] === 1) floor.push(i);
    const bodies = [];
    for (let n = 0; n < 18; n++) {
      const e = g.pool.acquire('walker');
      const t = floor[Math.floor(g.rng.next() * floor.length)];
      e.spawn('walker', (t % 56 + 0.5) * 4, (Math.floor(t / 56) + 0.5) * 4, 1e6, 1, null, g.rng);
      e.state = 'hunt';
      bodies.push({ e, reached: -1, start: Math.hypot(e.x - g.player.x, e.z - g.player.z) });
    }
    const dt = 1 / 60;
    for (let f = 0; f < seconds * 60; f++) {
      g.player.health = g.player.maxHealth;
      if (pure) for (const b of bodies) b.e.lostTime = 0;
      g.update(dt);
      for (const b of bodies) {
        if (b.reached >= 0 || !b.e.active) continue;
        if (Math.hypot(b.e.x - g.player.x, b.e.z - g.player.z) < 5) b.reached = f * dt;
      }
    }
    const reached = bodies.filter((b) => b.reached >= 0);
    const recycled = bodies.filter((b) => !b.e.active).length;
    const times = reached.map((b) => b.reached).sort((a, b) => a - b);
    return {
      reached: reached.length,
      recycled,
      median: times.length ? times[Math.floor(times.length / 2)].toFixed(1) : '-',
      slowest: times.length ? times[times.length - 1].toFixed(1) : '-',
      stuck: bodies.filter((b) => b.reached < 0 && b.e.active).map((b) => `${(b.e.x / 4).toFixed(1)},${(b.e.z / 4).toFixed(1)}`),
    };
  }, { seed, seconds: SECONDS, pure: PURE });
  console.log(`seed ${String(seed).padEnd(6)} reached ${String(r.reached).padStart(2)}/18  recycled ${r.recycled}  median ${r.median}s  slowest ${r.slowest}s  never arrived: ${r.stuck.join(' ') || 'none'}`);
}
await browser.close();
server.close();
