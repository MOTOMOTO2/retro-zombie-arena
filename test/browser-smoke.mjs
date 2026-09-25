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
    '--autoplay-policy=no-user-gesture-required',
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

  check('renders at a low internal resolution', frame.height <= 540 && frame.height < 720, `${frame.width}x${frame.height}`);
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

    // Buy the first door out of the start room.
    const start = game.layout.spawnZone;
    const door = game.props.doors.find((d) => d.def.connects.includes(start));
    const beyond = door.def.connects.find((z) => z !== start);
    out.onlyStartOpenAtFirst = game.openZones.size === 1 && game.openZones.has(start);
    game.update(1 / 60);
    game.buyDoor(door);
    out.doorOpened = door.open;
    out.doorCostPaid = before - game.player.points === door.def.cost;
    out.zoneUnlocked = game.openZones.has(beyond);
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
    game.newRun(4242);
    game.input.locked = true;
    game.player.giveWeapon('trench');
    game.viewmodel.equip(game.player.slot.id);

    // Stand at the west edge of the start room on a row with a clear run east
    // (no pillars, no props in the way), so the shots have a clean line.
    const home = game.layout.zones.find((z) => z.id === game.layout.spawnZone);
    let lane = home.rect.z + 1;
    const clear = (row) => {
      for (let x = home.rect.x; x < home.rect.x + 6; x++) if (game.layout.tiles[row * 56 + x] !== 1) return false;
      return true;
    };
    while (!clear(lane)) lane++;
    game.player.x = (home.rect.x + 0.5) * 4;
    game.player.z = (lane + 0.5) * 4;
    game.player.yaw = -Math.PI / 2;
    game.player.pitch = 0;
    game.pool.reset();

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
    game.pool.reset();
    game.player.giveWeapon('trench');
    game.viewmodel.equip(game.player.slot.id);
    const L = game.layout;
    const room = L.zones.find((z) => z.id === L.spawnZone);
    let row = room.rect.z + 1;
    while (L.tiles[row * 56 + room.rect.x - 1] !== 2) row++;
    game.player.x = (room.rect.x + 0.5) * 4;
    game.player.z = (row + 0.5) * 4;
    game.player.yaw = Math.PI / 2; // forward is (-sin, -cos): straight at the west wall
    game.player.pitch = 0;
    const behind = game.pool.acquire('walker');
    behind.spawn('walker', (room.rect.x - 2.5) * 4, (row + 0.5) * 4, 400, 3, null, game.rng);
    behind.state = 'hunt';
    const hpBefore = behind.health;
    game.input.fire = true;
    for (let i = 0; i < 40; i++) game.update(1 / 60);
    game.input.fire = false;
    out.wallsStopBullets = behind.health === hpBefore;
    // ...and the same shots do land when nothing is in the way. (The old
    // version of this check faced away from the wall, so it could not fail.)
    game.player.slot.mag = 30;
    game.player.x += 12;
    behind.x = game.player.x - 9;
    behind.z = game.player.z;
    game.input.fire = true;
    for (let i = 0; i < 40; i++) game.update(1 / 60);
    game.input.fire = false;
    out.sameShotsHitInOpen = behind.health < hpBefore || behind.state === 'dead';

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

  // ------------------------------------------------------- random asylums
  const maps = await page.evaluate(() => {
    const { game } = window.__RZA;
    const info = game.retro.renderer.info;
    const seeds = [];
    const shapes = new Set();
    let geoAfter2 = 0;
    for (let i = 0; i < 6; i++) {
      game.newRun();
      seeds.push(game.seed);
      shapes.add(Array.from(game.layout.tiles).join(''));
      for (let k = 0; k < 5; k++) game.update(1 / 60);
      game.render();
      if (i === 1) geoAfter2 = info.memory.geometries;
    }
    const geoAfter6 = info.memory.geometries;
    game.newRun(123456);
    const a = Array.from(game.layout.tiles).join('');
    const nameA = game.currentZoneName;
    game.newRun(123456);
    const b = Array.from(game.layout.tiles).join('');
    return {
      distinct: shapes.size, seeds, geoAfter2, geoAfter6,
      replay: a === b && game.seed === 123456, nameA,
      inStartRoom: game.currentZoneName !== 'CORRIDOR',
    };
  });
  check('every run gets a different asylum', maps.distinct === 6, `seeds ${maps.seeds.join(', ')}`);
  check('a seed replays the same asylum', maps.replay);
  check('the player wakes up inside the start room', maps.inStartRoom, maps.nameA);
  check('rebuilding the world does not leak GPU memory', maps.geoAfter6 - maps.geoAfter2 < 60,
    `geometries ${maps.geoAfter2} -> ${maps.geoAfter6}`);

  // ------------------------------------------------------ weapons in hand
  const arms = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun(4242);
    game.input.locked = true;
    game.pool.reset();
    game.roundPhase = 'clear';
    game.phaseTimer = 999;
    const ids = ['sidearm', 'boomstick', 'trench', 'grease', 'nailrifle', 'longshot', 'scattergun', 'ripper', 'plasma', 'hellfire', 'thunder'];
    const events = [];
    const vm = game.viewmodel;
    const prev = vm.onEvent;
    vm.onEvent = (e) => { events.push(e); prev(e); };
    const bad = [];
    for (const id of ids) {
      game.player.slots = [{ id, mag: 0, reserve: 400, packed: false }];
      game.player.activeSlot = 0;
      game.equipCurrent();
      for (let i = 0; i < 30; i++) game.update(1 / 60);
      const before = events.length;
      if (!game.startReload()) { bad.push(`${id}: reload refused`); continue; }
      for (let i = 0; i < 60 * 12 && (game.player.reloading || vm.busyPose !== 'idle'); i++) game.update(1 / 60);
      for (let i = 0; i < 60; i++) game.update(1 / 60);
      if (game.player.slot.mag === 0) bad.push(`${id}: never refilled`);
      if (vm.busyPose !== 'idle') bad.push(`${id}: stuck in ${vm.busyPose}`);
      if (events.length === before) bad.push(`${id}: silent reload`);
    }
    // The scoped rifle hides the gun and shows the scope when aimed.
    game.player.slots = [{ id: 'longshot', mag: 5, reserve: 40, packed: false }];
    game.equipCurrent();
    game.input.aim = true;
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    const scoped = vm.scopeView && document.getElementById('scope').classList.contains('show');
    game.input.aim = false;
    for (let i = 0; i < 30; i++) game.update(1 / 60);
    const unscoped = !vm.scopeView && !document.getElementById('scope').classList.contains('show');
    // Pack-a-Punch camo builds and renders.
    game.player.slot.packed = true;
    game.equipCurrent();
    game.render();
    vm.onEvent = prev;
    return { bad, scoped, unscoped, kinds: [...new Set(events)].length };
  });
  check('every weapon reloads all the way through its animation', arms.bad.length === 0, arms.bad.join(' | '));
  check('reloads cue their own foley', arms.kinds >= 12, `${arms.kinds} distinct cues`);
  check('the scoped rifle shows its scope when aimed', arms.scoped && arms.unscoped);

  // ------------------------------------------------------- zombie voices
  const voices = await page.evaluate(async () => {
    const { audio } = window.__RZA;
    await audio.resume();
    audio.setListener({ x: 0, z: 0 }, 0);
    for (const kind of ['moan', 'growl', 'snarl', 'scream', 'death']) audio.zombieVoice({ x: 3, z: 0 }, kind, 1);
    const active = audio.activeVoices;
    // Flood it: the limiter must hold the line.
    for (let i = 0; i < 40; i++) audio.zombieVoice({ x: i * 0.5, z: 0 }, 'moan', 1);
    const capped = audio.activeVoices;
    for (const m of ['magOut', 'magIn', 'rack', 'breakOpen', 'shellIn', 'pump', 'boltBack', 'cellIn', 'swing']) audio.mech(m);
    return { active, capped, state: audio.ctx ? audio.ctx.state : 'none' };
  });
  check('zombies have voices', voices.active === 5, `${voices.active} sounding, context ${voices.state}`);
  check('a horde cannot drown the mix', voices.capped <= 7, `${voices.capped} voices after a flood`);

  // --------------------------------------------------------- stability
  const perf = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun();
    game.input.locked = true;
    // Keep the player standing so the horde keeps working for the whole measurement.
    const live = () => { game.player.health = game.player.maxHealth; };
    for (let i = 0; i < 60 * 20; i++) { live(); game.update(1 / 60); }
    const alive = game.pool.liveCount;
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) { live(); game.update(1 / 60); }
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
    return { simMs, drawMs, calls, triangles, geometries: info.memory.geometries, alive, state: game.state };
  });

  check('geometry is on the GPU', perf.triangles > 1000, `${perf.triangles} tris, ${perf.calls} draw calls`);
  check('simulation step is cheap', perf.simMs < 8 && perf.state === 'playing', `${perf.simMs.toFixed(3)} ms/step with ${perf.alive} zombies alive`);
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
