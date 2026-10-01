/**
 * Screenshots of the story side of the game: the chapter select, a briefing,
 * the objective HUD and radio, the quest props, each boss up close with its
 * health bar, and the victory screen.
 *
 *   npm run build && node tools/story.mjs
 *
 * Shots land in tools/shots/story/.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const OUT = 'tools/shots/story';

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
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`wrote ${name}`);
};

// Menus.
await page.evaluate(() => {
  const { progress } = window.__RZA;
  if (!progress.unlocked.includes('town')) progress.unlocked.push('town');
  progress.records.asylum = { bestRound: 8, bestKills: 120, bestPoints: 18000, escaped: true, fastestEscape: 8 };
  document.getElementById('btn-play').click();
});
await shot('chapters');
await page.evaluate(() => document.querySelectorAll('#map-cards .card')[1].click());
await shot('briefing');

// Helpers inside the page: stand somewhere and look at something.
await page.evaluate(() => {
  const { game } = window.__RZA;
  window.__look = (fromX, fromZ, atX, atZ, pitch = -0.05, frames = 4) => {
    game.player.x = fromX;
    game.player.z = fromZ;
    game.player.yaw = Math.atan2(-(atX - fromX), -(atZ - fromZ));
    game.player.pitch = pitch;
    for (let i = 0; i < frames; i++) game.update(1 / 60);
    game.player.health = game.player.maxHealth;
    game.damageFlash = 0;
    game.retro.setDamage(0);
    game.fadeIn = 1;
    game.retro.setFade(1);
    game.render();
  };
  /** A spot `dist` in front of a wall prop, looking back at it. */
  window.__front = (p, dist) => {
    const nx = Math.sin(p.facing);
    const nz = Math.cos(p.facing);
    const cx = (p.tx + 0.5) * 4;
    const cz = (p.tz + 0.5) * 4;
    return { x: cx + nx * dist, z: cz + nz * dist, cx, cz };
  };
});

await page.evaluate(() => {
  const { game } = window.__RZA;
  game.newRun(4242, 'asylum');
  game.input.locked = true;
  document.getElementById('click-to-play').style.display = 'none';
  for (let i = 0; i < 60 * 4.5; i++) {
    game.player.health = game.player.maxHealth;
    game.update(1 / 60);
  }
  game.render();
});
await shot('hud-start');

await page.evaluate(() => {
  const { game } = window.__RZA;
  game.pool.reset();
  game.player.award(1e6);
  for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
  game.roundPhase = 'clear';
  game.phaseTimer = 1e9;
  const p = game.layout.parts[0];
  const f = window.__front(p, 9);
  window.__look(f.x, f.z, f.cx, f.cz, -0.12);
});
await shot('part');

await page.evaluate(() => {
  const { game } = window.__RZA;
  game.turnOnPower();
  game.takePart(0);
  game.takePart(1);
  const p = game.layout.workbench;
  const f = window.__front(p, 8);
  window.__look(f.x, f.z, f.cx, f.cz, -0.15, 30);
});
await shot('workbench');

await page.evaluate(() => {
  const { game } = window.__RZA;
  const p = game.layout.exit;
  const f = window.__front(p, 12);
  window.__look(f.x, f.z, f.cx, f.cz, 0.02, 10);
});
await shot('exit-sealed');

// Every boss, up close, without the chatter over the top.
await page.evaluate(() => {
  for (const id of ['toast', 'banner', 'radio']) document.getElementById(id).style.visibility = 'hidden';
});
for (const [map, id] of [['asylum', 'warden'], ['town', 'butcher'], ['foundry', 'furnace'], ['labs', 'patient0']]) {
  await page.evaluate(([map]) => {
    const { game } = window.__RZA;
    game.newRun(777, map);
    game.input.locked = true;
    game.player.award(1e6);
    for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
    game.pool.reset();
    game.roundPhase = 'clear';
    game.phaseTimer = 1e9;
    game.turnOnPower();
    for (let i = 0; i < 3; i++) game.takePart(i);
    game.buildDevice();
    game.quest.bossTimer = 0;
    game.update(1 / 60);
    // A wallet that looks like a real run rather than a test's million.
    game.player.points = 6240;
    game.hud.setPoints(6240);
    document.getElementById('points-delta').style.visibility = 'hidden';
    const b = game.pool.boss;
    // Stand in the start room with the boss a few steps away, facing us.
    const sp = game.layout.spawn;
    const px = (sp.tx + 0.5) * 4;
    const pz = (sp.tz + 0.5) * 4;
    let best = null;
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = px + Math.cos(ang) * 11;
      const z = pz + Math.sin(ang) * 11;
      if (game.grid.lineOfSight(px, pz, x, z) && game.grid.lineOfSight(x, z, x + 2, z) && game.grid.lineOfSight(x, z, x - 2, z)) {
        best = { x, z };
        break;
      }
    }
    b.target = null;
    b.state = 'hunt';
    b.y = 0;
    b.x = best ? best.x : px + 11;
    b.z = best ? best.z : pz;
    b.speed = 0.001;
    b.yaw = Math.atan2(px - b.x, pz - b.z);
    b.health = b.maxHealth * 0.62;
    window.__look(px, pz, b.x, b.z, 0.12, 3);
  }, [map]);
  await shot(`boss-${id}`);
}

// A boss winding up a slam, and a fireball in the air.
await page.evaluate(() => {
  const { game } = window.__RZA;
  const b = game.pool.boss;
  b.pending = 'slam';
  b.action = 'windup';
  b.actionT = 0.6;
  b.actionDur = 0.8;
  game.render();
});
await shot('boss-windup');

await page.evaluate(() => {
  const { game } = window.__RZA;
  game.quest.boss = 'alive';
  const b = game.pool.boss;
  game.damageEnemy(b, b.health + 10, false, false, { x: b.x, y: 3, z: b.z });
  for (let i = 0; i < 30; i++) game.update(1 / 60);
  const p = game.layout.exit;
  const f = window.__front(p, 12);
  window.__look(f.x, f.z, f.cx, f.cz, 0.02, 90);
});
await shot('exit-open');

await page.evaluate(() => {
  for (const id of ['toast', 'banner', 'radio']) document.getElementById(id).style.visibility = '';
  window.__RZA.game.tryEscape();
});
await page.waitForTimeout(300);
await shot('victory');

await browser.close();
server.close();
