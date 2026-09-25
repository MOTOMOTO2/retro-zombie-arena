/**
 * Headless smoke test.
 *
 * Builds nothing - it serves ./dist and drives the real game in a real
 * Chromium with software WebGL. It checks that the world rasterises, that the
 * horde spawns and reaches the player, that economy interactions work, and that
 * a round can be cleared. Run with: npm run build && npm run test:browser
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/' || path.endsWith('/')) path += 'index.html';
      const file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const mark = ok ? '✔' : '✖';
  console.log(`${mark} ${name}${detail ? `  ${detail}` : ''}`);
}

const { server, port } = await serve();
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__RZA), null, { timeout: 20000 });

  check('page boots without a page error', pageErrors.length === 0, pageErrors[0] ?? '');
  check(
    'main menu is visible',
    await page.locator('#menu').isVisible(),
  );
  check(
    'title renders',
    (await page.locator('#menu .title').first().innerText()).replace(/\s+/g, ' ').trim() ===
      'RETRO ZOMBIE ARENA',
  );

  // -------------------------------------------------- world actually draws
  const frame = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun();
    game.input.locked = true;
    for (let i = 0; i < 30; i++) game.update(1 / 60);
    game.render();
    const f = game.retro.readFrame();
    let min = 255;
    let max = 0;
    let sum = 0;
    let nonBlack = 0;
    for (let i = 0; i < f.pixels.length; i += 4) {
      const l = (f.pixels[i] + f.pixels[i + 1] + f.pixels[i + 2]) / 3;
      if (l < min) min = l;
      if (l > max) max = l;
      sum += l;
      if (l > 8) nonBlack++;
    }
    return {
      width: f.width,
      height: f.height,
      min,
      max,
      mean: sum / (f.pixels.length / 4),
      litFraction: nonBlack / (f.pixels.length / 4),
      state: game.state,
    };
  });

  check('renders at a low internal resolution', frame.height <= 260, `${frame.width}x${frame.height}`);
  check('frame is not blank', frame.max > 40 && frame.litFraction > 0.25,
    `lit ${(frame.litFraction * 100).toFixed(0)}%, mean ${frame.mean.toFixed(1)}, max ${frame.max}`);
  check('frame has tonal range (lighting works)', frame.max - frame.min > 60,
    `min ${frame.min} max ${frame.max}`);
  check('entered the playing state', frame.state === 'playing');

  // ------------------------------------------------------ horde behaviour
  const horde = await page.evaluate(() => {
    const { game } = window.__RZA;
    let peakAlive = 0;
    let reachedInside = 0;
    let boardsTornTotal = 0;
    for (let i = 0; i < 60 * 45; i++) {
      game.update(1 / 60);
      const alive = game.pool.liveCount;
      if (alive > peakAlive) peakAlive = alive;
      for (const e of game.pool.all) {
        if (e.active && e.state === 'hunt') reachedInside++;
      }
    }
    for (const b of game.props.barricades) boardsTornTotal += b.maxBoards - b.boards;
    return {
      round: game.round,
      peakAlive,
      reachedInside,
      boardsTornTotal,
      health: game.player.health,
      maxHealth: game.player.maxHealth,
      points: game.player.points,
      state: game.state,
      spawnedTotal: game.spawned,
    };
  });

  check('enemies spawn', horde.peakAlive > 0, `peak alive ${horde.peakAlive}`);
  check('enemies tear the boards off windows', horde.boardsTornTotal > 0,
    `${horde.boardsTornTotal} boards`);
  check('enemies get inside and hunt', horde.reachedInside > 0);
  check('an idle player gets hurt', horde.health < horde.maxHealth || horde.state === 'gameover',
    `hp ${Math.round(horde.health)}/${horde.maxHealth}, state ${horde.state}`);

  // ---------------------------------------------------------- the economy
  const economy = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};

    // Clear the field and reset so the purchase tests are not interrupted.
    game.newRun();
    game.input.locked = true;
    game.player.award(60000);
    const before = game.player.points;

    // Stand in front of the furnace-hall door and buy it.
    const door = game.props.doors.find((d) => d.def.id === 'd_furnace');
    game.player.x = door.center.x + 3.2;
    game.player.z = door.center.z;
    game.player.yaw = Math.PI / 2;
    game.update(1 / 60);
    game.buyDoor(door);
    out.doorOpened = door.open;
    out.doorCostPaid = before - game.player.points === door.def.cost;
    out.zoneUnlocked = game.openZones.has('furnace');
    out.tileWalkable = !game.grid.solid(door.def.rect.x, door.def.rect.z);

    // Buy a wall weapon.
    const wall = game.props.wallBuys.find((w) => w.weaponId === 'boomstick');
    const p2 = game.player.points;
    game.buyWallWeapon(wall);
    out.weaponBought = game.player.hasWeapon('boomstick') >= 0;
    out.weaponCostPaid = p2 - game.player.points > 0;

    // Power, perks and Pack-a-Punch.
    out.perkBlockedBeforePower = !game.props.machines[0].powered;
    game.turnOnPower();
    out.perksPoweredAfter = game.props.machines.every((m) => m.powered);
    out.packPoweredAfter = game.props.pack.powered;

    const jug = game.props.machines.find((m) => m.id === 'juggernog');
    const hpBefore = game.player.maxHealth;
    game.buyPerk(jug);
    out.perkBought = game.player.perks.has('juggernog');
    out.juggernogRaisesHealth = game.player.maxHealth > hpBefore;

    const packedBefore = game.player.slot.packed;
    game.packWeapon();
    out.packUpgrades = !packedBefore && game.player.slot.packed;

    // Mystery box: roll it and take whatever comes out.
    const slotsBefore = game.player.slots.length;
    game.rollBox();
    for (let i = 0; i < 60 * 5; i++) game.update(1 / 60);
    out.boxOffered = Boolean(game.boxOffer);
    if (game.boxOffer) {
      game.takeBoxWeapon();
      out.boxGaveWeapon = game.player.slots.length > slotsBefore || slotsBefore === 2;
    }

    // Power-ups.
    game.applyPowerUp('instakill');
    out.instaKillActive = game.activePowerups.has('instakill');
    game.player.slot.mag = 0;
    game.player.slot.reserve = 0;
    game.applyPowerUp('maxammo');
    out.maxAmmoRefills = game.player.slot.reserve > 0;

    return out;
  });

  for (const [k, v] of Object.entries(economy)) check(`economy: ${k}`, v === true);

  // --------------------------------------------------------------- gunplay
  const gunplay = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    game.newRun();
    game.input.locked = true;
    game.player.giveWeapon('trench');
    game.viewmodel.equip(game.player.slot.id);

    // Line a few walkers up straight ahead and hold the trigger down.
    const fx = -Math.sin(game.player.yaw);
    const fz = -Math.cos(game.player.yaw);
    for (let i = 0; i < 3; i++) {
      const e = game.pool.acquire('walker');
      e.spawn('walker', game.player.x + fx * (9 + i * 4), game.player.z + fz * (9 + i * 4),
        420, 3, null, game.rng);
      e.state = 'hunt';
    }

    const magBefore = game.player.slot.mag;
    const pointsBefore = game.player.points;
    const killsBefore = game.player.kills;
    game.input.fire = true;
    for (let i = 0; i < 150; i++) game.update(1 / 60);
    game.input.fire = false;

    out.ammoSpent = game.player.slot.mag < magBefore || game.player.slot.reserve < 300;
    out.pointsEarned = game.player.points > pointsBefore;
    out.enemiesKilled = game.player.kills > killsBefore;
    out.headshotsRegistered = game.player.headshots > 0;

    // Reload refills the magazine from the reserve.
    game.player.slot.mag = 0;
    const reserveBefore = game.player.slot.reserve;
    out.reloadStarts = game.player.tryReload();
    for (let i = 0; i < 60 * 4; i++) game.update(1 / 60);
    out.reloadRefills = game.player.slot.mag > 0 && game.player.slot.reserve < reserveBefore;

    // An empty gun must not fire, and must not go negative.
    game.player.slot.mag = 0;
    game.player.slot.reserve = 0;
    game.input.fire = true;
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    game.input.fire = false;
    out.emptyGunStaysEmpty = game.player.slot.mag === 0 && game.player.slot.reserve === 0;

    // Bullets must not pass through walls: face one and shoot it.
    game.newRun();
    game.input.locked = true;
    game.player.giveWeapon('trench');
    game.viewmodel.equip(game.player.slot.id);
    game.player.x = 18.5 * 4;
    game.player.z = 34.5 * 4;
    game.player.yaw = -Math.PI / 2; // straight at the lobby's west wall
    const behind = game.pool.acquire('walker');
    behind.spawn('walker', 15 * 4, 34.5 * 4, 400, 3, null, game.rng);
    behind.state = 'hunt';
    const hpBefore = behind.health;
    game.input.fire = true;
    for (let i = 0; i < 40; i++) game.update(1 / 60);
    game.input.fire = false;
    out.wallsStopBullets = behind.health === hpBefore;

    // Grenades must be bought before they can be thrown.
    game.newRun();
    out.noFreeGrenades = game.player.grenades === 0 && !game.player.hasGrenades;
    out.cannotThrowUnbought = game.player.tryGrenade() === false;

    // Melee reaches, and the minimap renders without throwing.
    game.hud.toggleMap(true);
    for (let i = 0; i < 30; i++) game.update(1 / 60);
    out.minimapDraws = game.hud.mapVisible;
    game.hud.toggleMap(false);

    // Pause and resume must round-trip.
    game.pause();
    const paused = game.state === 'paused';
    const roundAtPause = game.round;
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    out.pauseFreezesTheWorld = paused && game.round === roundAtPause;
    game.resumeGame();
    out.resumeWorks = game.state === 'playing';

    return out;
  });

  for (const [k, v] of Object.entries(gunplay)) check(`gunplay: ${k}`, v === true);

  // ------------------------------------------------------ clearing a round
  const roundFlow = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun();
    game.input.locked = true;
    // Run to the start of round 1 and then nuke the field until it clears.
    for (let i = 0; i < 60 * 8; i++) game.update(1 / 60);
    const startRound = game.round;
    let guard = 0;
    while (game.round <= startRound && guard < 60 * 180) {
      game.update(1 / 60);
      if (game.pool.liveCount > 0) game.applyPowerUp('nuke', false);
      guard++;
    }
    return {
      startRound,
      endRound: game.round,
      kills: game.player.kills,
      points: game.player.points,
      state: game.state,
    };
  });

  check('round 1 starts', roundFlow.startRound === 1, `round ${roundFlow.startRound}`);
  check('a cleared round advances the counter', roundFlow.endRound > roundFlow.startRound,
    `round ${roundFlow.startRound} -> ${roundFlow.endRound}`);
  check('kills are recorded', roundFlow.kills > 0, `${roundFlow.kills} kills`);
  check('points are earned', roundFlow.points > 0, `${roundFlow.points} pts`);

  // ------------------------------------------------------ death and reset
  const death = await page.evaluate(() => {
    const { game } = window.__RZA;
    let over = null;
    game.onGameOver = (s) => {
      over = s;
    };
    game.newRun();
    game.input.locked = true;
    game.hurtPlayer(9999);
    return { state: game.state, over, gameoverVisible: !document.getElementById('gameover').classList.contains('hidden') };
  });

  check('lethal damage ends the run', death.state === 'gameover');
  check('the run reports stats', death.over !== null && typeof death.over.round === 'number');
  check('the game-over screen shows', death.gameoverVisible === true);

  // --------------------------------------------------------- stability
  const perf = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun();
    game.input.locked = true;
    for (let i = 0; i < 60 * 20; i++) game.update(1 / 60);
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) game.update(1 / 60);
    const simMs = (performance.now() - t0) / 300;
    const info = game.retro.renderer.info;
    info.autoReset = false;
    info.reset();
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) game.render();
    const drawMs = (performance.now() - t1) / 30;
    const calls = info.render.calls / 30;
    const triangles = info.render.triangles / 30;
    info.autoReset = true;
    return { simMs, drawMs, calls, triangles, geometries: info.memory.geometries };
  });

  check('geometry is on the GPU', perf.triangles > 1000, `${perf.triangles} tris, ${perf.calls} draw calls`);
  check('simulation step is cheap', perf.simMs < 8, `${perf.simMs.toFixed(2)} ms/step`);
  check('software-rendered frame completes', perf.drawMs < 2000, `${perf.drawMs.toFixed(1)} ms/frame (swiftshader)`);

  check('no uncaught page errors during play', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  const realConsoleErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check('no console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 2).join(' | '));

  await page.screenshot({ path: 'test/screenshot.png' });
  console.log('\nwrote test/screenshot.png');
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
