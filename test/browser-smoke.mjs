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
const VOICE_LINES = JSON.parse(await readFile(new URL('../src/core/voicelines.json', import.meta.url), 'utf8'));
const VOICE_TAKES = Object.values(VOICE_LINES).reduce((n, s) => n + Object.values(s.lines).flat().length, 0);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
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

  // From here the test steps the simulation itself rather than waiting on frames,
  // so it takes presentation back off the frame loop: every update() repaints the
  // HUD, and a check can read it straight after the step that changed it.
  await page.evaluate(() => {
    window.__RZA.game.hostPresents = false;
  });

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

    const tierBefore = game.player.slot.tier;
    game.packWeapon();
    out.packUpgrades = tierBefore === 0 && game.player.slot.tier === 1;
    // And again: tier II brings an ammo mod.
    game.packWeapon();
    out.packGoesDeeper = game.player.slot.tier === 2 && game.player.slot.mod !== null;

    // Mystery box: roll it and take whatever comes out.
    const slotsBefore = game.player.slots.length;
    const unit = game.boxes.units[0];
    game.rollBox(unit);
    for (let i = 0; i < 60 * 5; i++) game.update(1 / 60);
    out.boxOffered = Boolean(unit.offer);
    out.boxNeverOffersWhatYouHave = !game.player.slots.some((s) => s.id === unit.offer);
    if (unit.offer) {
      game.takeBoxWeapon(unit);
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
      for (let x = home.rect.x; x < home.rect.x + 6; x++) if (game.layout.tiles[row * Math.sqrt(game.layout.tiles.length) + x] !== 1) return false;
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
    while (L.tiles[row * Math.sqrt(L.tiles.length) + room.rect.x - 1] !== 2) row++;
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

  // ----------------------------------------------- settings from the pause menu
  const menus = await page.evaluate(() => {
    const { game } = window.__RZA;
    const shown = (id) => !document.getElementById(id).classList.contains('hidden');
    const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    game.newRun();
    game.input.locked = true;
    game.pause();
    const out = { pausedShows: game.state === 'paused' && shown('pause') };
    document.getElementById('btn-pause-settings').click();
    out.settingsOpen = shown('settings') && !shown('pause') && game.state === 'paused';
    out.seeThrough = document.getElementById('settings').classList.contains('see-through');
    // A setting changed in-game takes effect immediately.
    const bright = document.getElementById('opt-bright');
    bright.value = '80';
    bright.dispatchEvent(new Event('input'));
    out.brightnessApplied = game.retro.material.uniforms.uExposure.value > 1.5;
    bright.value = '50';
    bright.dispatchEvent(new Event('input'));
    esc();
    out.escBacksOutToPause = !shown('settings') && shown('pause') && game.state === 'paused';
    document.getElementById('btn-pause-settings').click();
    document.getElementById('btn-settings-back').click();
    out.backButtonToo = !shown('settings') && shown('pause');
    esc();
    out.escAgainResumes = game.state === 'playing' && !shown('pause');
    // And from the main menu it is the same screen.
    game.abandon();
    document.getElementById('btn-settings').click();
    out.mainMenuOpensIt = shown('settings') && !shown('menu') && !document.getElementById('settings').classList.contains('see-through');
    esc();
    out.mainMenuReturns = shown('menu') && !shown('settings');
    return out;
  });
  for (const [k, v] of Object.entries(menus)) check(`menus: ${k}`, v === true);

  // ------------------------------------------------------------- the horde
  const horde2 = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    game.newRun(4242);
    game.input.locked = true;
    game.pool.reset();
    game.player.award(1e6);
    for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
    game.roundPhase = 'clear';
    game.phaseTimer = 1e9;
    // Scatter walkers across the fully opened asylum; every one must find the player.
    const L = game.layout;
    const floor = [];
    for (let i = 0; i < L.tiles.length; i++) if (L.tiles[i] === 1) floor.push(i);
    const bodies = [];
    for (let n = 0; n < 12; n++) {
      const e = game.pool.acquire('walker');
      const t = floor[(n * 7919) % floor.length];
      const W = Math.sqrt(L.tiles.length);
      e.spawn('walker', ((t % W) + 0.5) * 4, (Math.floor(t / W) + 0.5) * 4, 1e6, 1, null, game.rng);
      e.state = 'hunt';
      bodies.push({ e, reached: false });
    }
    // The maps are big now: the far corner can be a hundred tiles of path away.
    for (let f = 0; f < 60 * 120; f++) {
      game.player.health = game.player.maxHealth;
      for (const b of bodies) b.e.lostTime = 0;
      game.update(1 / 60);
      for (const b of bodies) {
        if (Math.hypot(b.e.x - game.player.x, b.e.z - game.player.z) < 5) b.reached = true;
      }
    }
    out.everyZombieFindsThePlayer = bodies.every((b) => b.reached);
    out.reached = bodies.filter((b) => b.reached).length;

    // Hits: a flinch, a stagger and a shove away from the shooter.
    game.pool.reset();
    const e = game.pool.acquire('walker');
    e.spawn('walker', game.player.x + 6, game.player.z, 500, 3, null, game.rng);
    e.state = 'hunt';
    for (let i = 0; i < 10; i++) game.update(1 / 60);
    const before = { x: e.x, bodyPitch: e.model.body.rotation.x };
    const res = e.applyDamage(120, false, false, 1, 0);
    for (let i = 0; i < 6; i++) game.update(1 / 60);
    out.hitIsNotAKill = !res.killed && e.state !== 'dead';
    out.hitRocksTheBody = Math.abs(e.model.body.rotation.x - before.bodyPitch) > 0.1;
    out.hitShovesItBack = e.x > before.x - 0.05;
    // Deaths: the body falls, lies on the floor, then goes back to the pool.
    const kill = e.applyDamage(1000, true, false, 1, 0);
    out.killRegisters = kill.killed && e.state === 'dead';
    out.headshotTakesTheHead = kill.headless && !e.model.head.visible;
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    out.bodyIsDown = Math.abs(e.model.root.rotation.x) > 1.2 || Math.abs(e.model.root.rotation.z) > 1.2;
    out.corpseLingers = e.active;
    for (let i = 0; i < 60 * 4; i++) game.update(1 / 60);
    out.corpseCleansUp = !e.active;
    // The dead do not catch bullets.
    let hitDead = false;
    game.pool.forEachLive((z) => { if (z === e) hitDead = true; });
    out.deadAreNotTargets = !hitDead;
    return out;
  });
  for (const [k, v] of Object.entries(horde2)) {
    if (k === 'reached') continue;
    check(`horde: ${k}`, v === true, k === 'everyZombieFindsThePlayer' ? `${horde2.reached}/12` : '');
  }

  // ------------------------------------------------------- random asylums
  const maps = await page.evaluate(() => {
    const { game } = window.__RZA;
    const info = game.retro.renderer.info;
    const seeds = [];
    const shapes = new Set();
    for (let i = 0; i < 6; i++) {
      game.newRun();
      seeds.push(game.seed);
      shapes.add(Array.from(game.layout.tiles).join(''));
    }
    // Leaks: rebuild the same layout over and over; the count must not climb.
    // (Different layouts put different props in view, so only identical ones compare.)
    let geoAfter2 = 0;
    for (let i = 0; i < 6; i++) {
      game.newRun(5151);
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
  check('rebuilding the world does not leak GPU memory', maps.geoAfter6 - maps.geoAfter2 < 12,
    `geometries ${maps.geoAfter2} -> ${maps.geoAfter6}`);

  // ------------------------------------------------------ weapons in hand
  const arms = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun(4242);
    game.input.locked = true;
    game.pool.reset();
    game.roundPhase = 'clear';
    game.phaseTimer = 999;
    const ids = ['sidearm', 'boomstick', 'trench', 'grease', 'nailrifle', 'longshot', 'scattergun', 'ripper', 'plasma', 'hellfire', 'thunder', 'stormcaller', 'wintershowl', 'dragonfire'];
    const events = [];
    const vm = game.viewmodel;
    const prev = vm.onEvent;
    vm.onEvent = (e) => { events.push(e); prev(e); };
    const bad = [];
    for (const id of ids) {
      game.player.slots = [{ id, mag: 0, reserve: 400, tier: 0, mod: null }];
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
    game.player.slots = [{ id: 'longshot', mag: 5, reserve: 40, tier: 0, mod: null }];
    game.equipCurrent();
    game.input.aim = true;
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    const scoped = vm.scopeView && document.getElementById('scope').classList.contains('show');
    game.input.aim = false;
    for (let i = 0; i < 30; i++) game.update(1 / 60);
    const unscoped = !vm.scopeView && !document.getElementById('scope').classList.contains('show');
    // Pack-a-Punch camo builds and renders.
    game.player.slot.tier = 3;
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

  // ------------------------------------------- which ear, grunts, announcer
  const ears = await page.evaluate(async () => {
    const { audio, game } = window.__RZA;
    const prev = game.state;
    game.state = 'paused'; // so the live game cannot move the ears or make noise
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2600); // let the flood of moans die away

    const ctx = audio.ctx;
    const split = ctx.createChannelSplitter(2);
    audio.sfxBus.connect(split);
    const taps = [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, ch);
      return a;
    });
    const buf = new Float32Array(1024);
    const listen = async (ms) => {
      const e = [0, 0];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        taps.forEach((a, i) => {
          a.getFloatTimeDomainData(buf);
          for (const x of buf) e[i] += x * x;
        });
        await wait(10);
      }
      return e;
    };

    audio.setListener({ x: 0, z: 0 }, 0);
    audio.zap({ x: 8, z: 0 });
    const right = await listen(300);
    audio.zap({ x: -8, z: 0 });
    const left = await listen(300);
    // A moan that starts on the right must end up on the left once you turn round.
    audio.zombieVoice({ x: 8, z: 0 }, 'moan', 1);
    const before = await listen(300);
    audio.setListener({ x: 0, z: 0 }, Math.PI);
    const after = await listen(300);
    await wait(2400);
    audio.setListener({ x: 0, z: 0 }, 0);
    audio.hurt(34, 0.6);
    const grunt = await listen(400);

    // The announcer: a recorded line, through the mix, dead centre.
    const loaded = await audio.voicesReady;
    await wait(600);
    game.applyPowerUp('doublepoints');
    const called = audio.lastLine;
    const announcer = await listen(900);
    // Nobody talks over him.
    const overAnnouncer = audio.callout('boss');
    await wait(900);
    // The player: one line at a time, with room between them, unless it matters.
    const first = audio.callout('perk');
    const crowded = audio.callout('perk');
    const urgent = audio.callout('boss');
    const player = await listen(600);

    split.disconnect();
    audio.sfxBus.disconnect(split);
    game.state = prev;
    return { right, left, before, after, grunt, loaded, called, announcer, overAnnouncer, first, crowded, urgent, player, last: audio.lastLine };
  });
  const side = ([l, r]) => (r - l) / Math.max(1e-9, r + l);
  check('a sound on the right is heard on the right', side(ears.right) > 0.25, `balance ${side(ears.right).toFixed(2)}`);
  check('a sound on the left is heard on the left', side(ears.left) < -0.25, `balance ${side(ears.left).toFixed(2)}`);
  check('a sound on the right is not cut from the left ear', ears.right[0] > ears.right[1] * 0.05, `L/R ${(ears.right[0] / ears.right[1]).toFixed(2)}`);
  check(
    'turning round re-pans a sound already playing',
    side(ears.before) > 0.2 && side(ears.after) < -0.15,
    `balance ${side(ears.before).toFixed(2)} then ${side(ears.after).toFixed(2)}`,
  );
  check('the player grunts, dead centre, when hit', ears.grunt[0] > 0.5 && Math.abs(side(ears.grunt)) < 0.1, `energy ${ears.grunt[0].toFixed(1)}, balance ${side(ears.grunt).toFixed(2)}`);
  check('every recorded voice line loads', ears.loaded === VOICE_TAKES, `${ears.loaded}/${VOICE_TAKES} takes`);
  check(
    'the announcer calls out power-ups in a recorded voice',
    ears.called === 'announcer.doublepoints' && ears.announcer[0] > 1 && Math.abs(side(ears.announcer)) < 0.1,
    `${ears.called}, energy ${ears.announcer[0].toFixed(1)}, balance ${side(ears.announcer).toFixed(2)}`,
  );
  check('the player does not talk over the announcer', ears.overAnnouncer === false);
  check(
    'the player talks one line at a time, urgent lines cutting in',
    ears.first === true && ears.crowded === false && ears.urgent === true && ears.last === 'player.boss' && ears.player[0] > 0.5,
    `first ${ears.first}, crowded ${ears.crowded}, urgent ${ears.urgent}, energy ${ears.player[0].toFixed(1)}`,
  );

  // ---------------------------------------------------------- arcade music
  const music = await page.evaluate(async () => {
    const { audio, game } = window.__RZA;
    const prev = game.state;
    game.state = 'paused'; // the test drives the music itself
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ctx = audio.ctx;
    const tap = ctx.createAnalyser();
    tap.fftSize = 1024;
    audio.musicBus.connect(tap);
    audio.stopMusic();
    await wait(300);
    audio.startMusic();
    let intensity = 0.3;
    const pump = setInterval(() => audio.updateMusic(1 / 60, intensity), 16);
    await wait(400);
    const calm = audio.musicPosition?.section;
    audio.musicCue('fight');
    await wait(2600);
    const fight = { ...audio.musicPosition };

    // Loudness every 20 ms: a tune with a beat keeps jumping; a drone does not.
    const buf = new Float32Array(1024);
    const env = [];
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      tap.getFloatTimeDomainData(buf);
      let e = 0;
      for (const x of buf) {
        e += x * x;
        peak = Math.max(peak, Math.abs(x));
      }
      env.push(Math.sqrt(e / buf.length));
      await wait(20);
    }
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    let onsets = 0;
    for (let i = 1, quiet = 0; i < env.length; i++, quiet++) {
      if (quiet >= 3 && env[i] > env[i - 1] * 1.3 && env[i] > mean * 0.6) {
        onsets++;
        quiet = 0;
      }
    }

    intensity = 1;
    await wait(4000);
    const fast = { ...audio.musicPosition };
    audio.musicCue('calm');
    await wait(2600);
    const back = audio.musicPosition?.section;
    clearInterval(pump);
    audio.musicBus.disconnect(tap);
    audio.stopMusic();
    await wait(300);
    game.state = prev;
    return { calm, fight, mean, peak, onsets, fast, back, stopped: audio.musicPosition === null };
  });
  check('the music starts in its between-rounds breakdown', music.calm === 'C', `section ${music.calm}`);
  check('a round kicks the music into the tune', music.fight.section === 'A', `section ${music.fight.section}, ${music.fight.bpm} BPM`);
  check('the music is audible and does not clip', music.mean > 0.01 && music.peak < 1, `rms ${music.mean.toFixed(3)}, peak ${music.peak.toFixed(2)}`);
  check('the music has a beat', music.onsets >= 6, `${music.onsets} onsets in 2.5 s`);
  check(
    'the music speeds up and hits harder with the horde',
    music.fast.bpm > music.fight.bpm + 8 && music.fast.level >= music.fight.level,
    `${music.fight.bpm} → ${music.fast.bpm} BPM, drums ${music.fight.level} → ${music.fast.level}`,
  );
  check('between rounds the music drops back to the breakdown', music.back === 'C', `section ${music.back}`);
  check('the music stops', music.stopped);

  // ---------------------------------------- health bars and damage numbers
  const tags = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun(123456);
    game.pool.reset();
    const p = game.player;
    const step = (n) => { for (let i = 0; i < n; i++) game.update(1 / 60); };
    const shown = (sel) => [...document.querySelectorAll(`#tags ${sel}`)].filter((n) => n.style.display === 'block');
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let d = 12;
    while (d > 4 && !game.grid.lineOfSight(p.x, p.z, p.x + fx * d, p.z + fz * d)) d--;
    const e = game.pool.acquire('walker');
    e.spawn('walker', p.x + fx * d, p.z + fz * d, 500, 3, null, game.rng);
    e.state = 'hunt';
    e.shocked = 99; // stunned where it stands
    step(4);
    const out = { fresh: game.tags.visible };

    // A two-pellet hit reads as one number.
    game.damageEnemy(e, 120, false, false, { x: e.x, y: 2.5, z: e.z });
    game.damageEnemy(e, 30, false, false, { x: e.x, y: 2.5, z: e.z });
    step(3);
    out.hurt = game.tags.visible;
    out.numbers = shown('.dmg').map((n) => n.textContent);
    const bar = shown('.ztag')[0];
    out.fill = bar ? bar.querySelector('.fill').style.transform : '';
    out.barAbove = bar ? bar.getBoundingClientRect().top < window.innerHeight / 2 + 40 : false;

    step(15);
    game.damageEnemy(e, 50, true, false, { x: e.x, y: 3.2, z: e.z });
    step(2);
    out.head = shown('.dmg.head').map((n) => n.textContent);

    game.tags.showNumbers = false;
    step(15);
    game.damageEnemy(e, 10, false, false, { x: e.x, y: 2.5, z: e.z });
    step(2);
    out.numbersOff = shown('.dmg').filter((n) => n.textContent === '10').length;
    game.tags.showNumbers = true;
    game.tags.showBars = false;
    step(20);
    out.barsOff = game.tags.visible.bars;
    game.tags.showBars = true;

    step(15);
    game.damageEnemy(e, 5000, true, false, { x: e.x, y: 3.2, z: e.z });
    step(2);
    out.kill = shown('.dmg.kill').map((n) => n.textContent);
    step(90);
    out.after = game.tags.visible;
    return out;
  });
  check('a zombie at full health has no bar', tags.fresh.bars === 0);
  check('a hurt zombie shows a health bar above it', tags.hurt.bars === 1 && tags.barAbove, `${tags.hurt.bars} bars, ${tags.fill}`);
  check('the bar shows the health left', /^scaleX\(0\.70*\)$/.test(tags.fill), tags.fill);
  check('pellets landing together read as one number', tags.numbers.join() === '150', tags.numbers.join() || 'none');
  check('a headshot gets its own number', tags.head.join() === '50', tags.head.join() || 'none');
  check('a kill shows the damage it took to finish it', tags.kill.join() === '290', tags.kill.join() || 'none');
  check('health bars and damage numbers can be turned off', tags.numbersOff === 0 && tags.barsOff === 0, `${tags.numbersOff} numbers, ${tags.barsOff} bars`);
  check("the numbers and the dead zombie's bar clear away", tags.after.bars === 0 && tags.after.numbers === 0, JSON.stringify(tags.after));

  // ------------------------------------------- which way the hit came from
  const hurt = await page.evaluate(() => {
    const { game } = window.__RZA;
    game.newRun(777);
    const p = game.player;
    const dir = document.getElementById('damage-dir');
    // The wedge sits on a zero-sized box in the middle of the screen, so its
    // rotation is the bearing the game read off the hit.
    const wedge = () => {
      const deg = /rotate\(([-\d.]+)deg\)/.exec(dir.style.transform);
      return { deg: deg ? Math.round(Number(deg[1])) : null, shown: dir.style.opacity === '1' };
    };
    const from = (dx, dz) => {
      p.health = p.maxHealth;
      game.hurtPlayer(5, { x: p.x + dx, z: p.z + dz });
      return wedge();
    };
    const out = {};
    p.yaw = 0; // facing -z
    out.ahead = from(0, -10);
    out.behind = from(0, 10);
    out.right = from(10, 0);
    out.left = from(-10, 0);
    // Turned a quarter turn, the same attacker is off to one side: facing -x,
    // something standing at -z is on the player's right.
    p.yaw = Math.PI / 2;
    out.turned = from(0, -10);
    // Your own grenade, or ground you are standing in, has no bearing to show.
    dir.style.opacity = '0';
    p.health = p.maxHealth;
    game.hurtPlayer(5);
    out.noDirection = wedge();
    return out;
  });
  check('a hit from ahead points up', hurt.ahead.deg === 0 && hurt.ahead.shown, JSON.stringify(hurt.ahead));
  check('a hit from behind points down', Math.abs(hurt.behind.deg) === 180, JSON.stringify(hurt.behind));
  check('a hit from the right points right', hurt.right.deg === 90, JSON.stringify(hurt.right));
  check('a hit from the left points left', hurt.left.deg === -90, JSON.stringify(hurt.left));
  check('the wedge follows where the player is facing', hurt.turned.deg === 90, JSON.stringify(hurt.turned));
  check('damage with no direction shows no wedge', hurt.noDirection.shown === false, JSON.stringify(hurt.noDirection));

  // ------------------------------------------------- shake, sway and settings
  const motion = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    game.newRun(999);
    const p = game.player;
    p.yaw = 0;
    p.pitch = 0;

    // How far the camera wanders over a second of the biggest shake there is.
    const spread = () => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 60; i++) {
        game.shake = 4;
        game.update(1 / 60);
        lo = Math.min(lo, game.camera.position.x);
        hi = Math.max(hi, game.camera.position.x);
      }
      return hi - lo;
    };
    game.shakeScale = 1;
    const shaky = spread();
    game.shakeScale = 0;
    const still = spread();
    out.shakeMoves = shaky > 0.02;
    out.shakeOffIsStill = still < 1e-9;
    out.shakeScales = shaky > still * 10 || still === 0;
    game.shakeScale = 1;

    // The slider drives it, and settles at both ends.
    const slider = document.getElementById('opt-shake');
    const set = (v) => {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(0);
    out.sliderOff = game.shakeScale === 0 && document.getElementById('val-shake').textContent === '0';
    set(40);
    out.sliderScales = Math.abs(game.shakeScale - 0.4) < 1e-9;
    set(100);
    out.sliderBack = game.shakeScale === 1;

    // Nonsense in storage must not reach the camera.
    const saved = localStorage.getItem('rza.settings.v2');
    localStorage.setItem('rza.settings.v2', JSON.stringify({
      quality: 'nope', shake: 'lots', sway: null, fov: 1e9, sensitivity: -5, volume: NaN,
    }));
    const loaded = window.__RZA.reloadSettings();
    out.badQualityFalls = Boolean(loaded.quality) && loaded.quality !== 'nope';
    out.badNumbersFall = [loaded.shake, loaded.sway, loaded.fov, loaded.sensitivity, loaded.volume]
      .every((n) => Number.isFinite(n));
    out.numbersStayInRange = loaded.fov <= 110 && loaded.fov >= 65 && loaded.sensitivity >= 4
      && loaded.shake >= 0 && loaded.shake <= 100;
    out.cameraStaysFinite = Number.isFinite(game.camera.position.x) && Number.isFinite(game.camera.position.y);
    if (saved === null) localStorage.removeItem('rza.settings.v2');
    else localStorage.setItem('rza.settings.v2', saved);
    return out;
  });
  for (const [k, v] of Object.entries(motion)) check(`motion: ${k}`, v === true);

  // --------------------------------------------------------- rebinding keys
  const keys = await page.evaluate(async () => {
    const { game } = window.__RZA;
    const out = {};
    const shown = (id) => !document.getElementById(id).classList.contains('hidden');
    const press = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    const rows = () => [...document.querySelectorAll('#key-rows .bind')];
    const rowFor = (name) => rows().find((r) => r.querySelector('span').textContent === name);

    game.abandon();
    document.getElementById('btn-settings').click();
    document.getElementById('btn-controls').click();
    out.panelOpens = shown('menu-controls') && rows().length > 10;
    out.listsDefault = rowFor('JUMP').querySelector('button').textContent === 'SPACE';

    // Click the row, then press the key: the list and the bindings both follow.
    rowFor('JUMP').querySelector('button').click();
    out.waitsForAKey = rowFor('JUMP').querySelector('button').textContent === 'PRESS A KEY';
    press('KeyB');
    out.rebound = rowFor('JUMP').querySelector('button').textContent === 'B'
      && game.input.keysFor('jump').join() === 'KeyB';
    out.oldKeyDead = !game.input.keysFor('jump').includes('Space');

    // Taking a key off another action leaves that one usable, not blank.
    rowFor('RELOAD').querySelector('button').click();
    press('KeyB');
    out.clashTakesTheKey = game.input.keysFor('reload').join() === 'KeyB';
    out.clashLeavesTheOtherUsable = game.input.keysFor('jump').length > 0
      && !game.input.keysFor('jump').includes('KeyB');

    // Esc cancels a rebind instead of closing the screen.
    rowFor('KNIFE').querySelector('button').click();
    press('Escape');
    out.escCancels = shown('menu-controls')
      && rowFor('KNIFE').querySelector('button').textContent !== 'PRESS A KEY';

    // The HOW TO PLAY list and the in-game prompt are written from the bindings.
    rowFor('BUY / USE / REPAIR').querySelector('button').click();
    press('KeyH');
    out.howtoFollows = document.getElementById('howto-use').textContent === 'H'
      && [...document.querySelectorAll('#howto-keys li')].some((li) => li.textContent === 'H buy / use / repair');

    // It survives a reload: the settings are saved as they are changed.
    out.saved = JSON.parse(localStorage.getItem('rza.settings.v2')).keys.use.join() === 'KeyH';

    document.getElementById('btn-keys-reset').click();
    out.resetRestoresDefaults = game.input.keysFor('jump').join() === 'Space'
      && game.input.keysFor('use').join() === 'KeyF,KeyE'
      && document.getElementById('howto-use').textContent === 'F';
    out.resetClearsTheSave = Object.keys(JSON.parse(localStorage.getItem('rza.settings.v2')).keys).length === 0;

    document.getElementById('btn-controls-back').click();
    document.getElementById('btn-settings-back').click();
    return out;
  });
  for (const [k, v] of Object.entries(keys)) check(`keys: ${k}`, v === true);

  // ------------------------------------------------------------ four maps
  const sweep = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    for (const id of ['asylum', 'town', 'foundry', 'labs']) {
      const t0 = performance.now();
      game.newRun(undefined, id);
      const ms = performance.now() - t0;
      game.input.locked = true;
      for (let i = 0; i < 10; i++) game.update(1 / 60);
      game.render();
      let sky = false;
      game.level.group.traverse((o) => { if (o.renderOrder === -1000) sky = true; });
      out[id] = {
        ms: Math.round(ms), map: game.mapId, sky,
        props: game.questProps.parts.length === game.quest.parts.length && game.questProps.valves.length === game.quest.valves.length,
        boxes: game.boxes.units.filter((u) => u.enabled).length, state: game.state,
        banner: document.getElementById('banner').textContent,
      };
    }
    return out;
  });
  const wantBoxes = { asylum: 1, town: 2, foundry: 2, labs: 2 };
  const wantSky = { asylum: false, town: true, foundry: true, labs: false };
  for (const [id, r] of Object.entries(sweep)) {
    check(`maps: ${id} builds and plays, with its chapter's props`, r.map === id && r.state === 'playing' && r.props, `${r.ms} ms, "${r.banner}"`);
    check(`maps: ${id} runs ${wantBoxes[id]} mystery box(es)`, r.boxes === wantBoxes[id], `${r.boxes}`);
    check(`maps: ${id} ${wantSky[id] ? 'has' : 'has no'} open sky`, r.sky === wantSky[id]);
    check(`maps: ${id} builds in reasonable time`, r.ms < 8000, `${r.ms} ms under swiftshader`);
  }

  // ------------------------------------------------------ the story chain
  const story = await page.evaluate(() => {
    const { game, progress } = window.__RZA;
    const shown = (id) => !document.getElementById(id).classList.contains('hidden');
    const live = () => { game.player.health = game.player.maxHealth; };
    const out = {};
    game.newRun(4242, 'asylum');
    game.input.locked = true;
    game.player.award(1e6);
    for (let i = 0; i < 10; i++) game.update(1 / 60);
    out.objectivesListed = document.querySelectorAll('#objective-list li').length === 3;
    out.waypointShows = shown('waypoint');
    for (let i = 0; i < 60 * 4; i++) { live(); game.update(1 / 60); }
    out.radioSpeaks = shown('radio') && document.getElementById('radio-text').textContent.length > 10;
    out.workbenchWaits = !game.quest.canBuild;
    game.turnOnPower();
    out.powerCounts = game.quest.power === true;
    game.takePart(0);
    game.takePart(1);
    out.partsCount = game.quest.partsFound === 2 && game.questProps.parts[0].taken;
    game.takePart(2);
    out.benchReady = game.quest.canBuild;
    // Open the map so the boss has somewhere to come in.
    for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
    game.pool.reset();
    game.buildDevice();
    out.deviceBuilt = game.quest.built && game.quest.boss === 'coming';
    for (let i = 0; i < 60 * 20 && game.quest.boss === 'coming'; i++) { live(); game.update(1 / 60); }
    const boss = game.pool.boss;
    out.bossArrives = game.quest.boss === 'alive' && Boolean(boss && boss.active);
    for (let i = 0; i < 5; i++) { live(); game.update(1 / 60); }
    out.bossBarShows = shown('boss-bar') && document.getElementById('boss-name').textContent === 'THE WARDEN';
    game.applyPowerUp('nuke', false);
    out.nukeSparesTheBoss = boss.state !== 'dead';
    out.cannotLeaveYet = (() => { game.tryEscape(); return game.state === 'playing'; })();
    game.damageEnemy(boss, boss.health + 10, false, false, { x: boss.x, y: 3, z: boss.z });
    out.bossDies = boss.state === 'dead' && game.quest.boss === 'dead';
    out.exitOpens = game.questProps.exit.open;
    for (let i = 0; i < 5; i++) { live(); game.update(1 / 60); }
    out.bossBarGoes = !shown('boss-bar');
    game.tryEscape();
    out.victory = game.state === 'victory' && shown('victory');
    out.endingShown = document.getElementById('win-story').textContent.length > 40;
    out.nextChapterUnlocked = progress.unlocked.includes('town') && shown('btn-next');
    // The boss body sinks away and leaves play on the next run.
    game.newRun(undefined, 'asylum');
    out.bossClearedOnNewRun = game.pool.boss === null;
    return out;
  });
  for (const [k, v] of Object.entries(story)) check(`story: ${k}`, v === true);

  // ------------------------------------------------- each chapter's own jobs
  const jobs = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    const step = (n) => { for (let i = 0; i < n; i++) { game.player.health = game.player.maxHealth; game.update(1 / 60); } };
    const at = (v) => { game.player.x = v.x; game.player.z = v.z; };
    const prompt = () => game.findInteractable()?.label ?? '';
    const prog = (i) => document.querySelectorAll('#objective-list li')[i]?.querySelector('.prog')?.textContent.trim() ?? '';
    const calm = () => { game.pool.reset(); game.roundPhase = 'clear'; game.phaseTimer = 1e9; };

    // The town: build the beacon, then hold it.
    game.newRun(31337, 'town');
    game.input.locked = true;
    game.player.award(1e6);
    for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
    calm();
    out.townTwoParts = game.questProps.parts.length === 2 && game.questProps.valves.length === 0;
    game.turnOnPower();
    game.takePart(0);
    game.takePart(1);
    game.buildDevice();
    out.townDefends = game.quest.stage === 'defend' && game.quest.boss === 'none';
    step(2);
    out.townRingShows = game.questProps.ring.group.visible;
    const bench = game.questProps.bench.center;
    at({ x: game.layout.spawn.tx * 4 + 2, z: game.layout.spawn.tz * 4 + 2 });
    step(60);
    out.townAwayHoldsNothing = game.quest.held === 0 && prog(3) === 'GET BACK TO IT';
    at(bench);
    step(60);
    out.townNearCounts = game.quest.held > 0.8 && /^0:5\d$/.test(prog(3));
    // The horde keeps coming past the round's count.
    game.roundPhase = 'active';
    game.spawned = game.plan.total;
    game.spawnTimer = 0;
    const before = game.spawned;
    step(30);
    out.townSurges = game.spawned > before;
    game.quest.held = 59.9;
    step(12);
    out.townBossComes = game.quest.boss === 'coming' && !game.questProps.ring.group.visible;

    // The ironworks: valves against the clock, then feed the crucible.
    game.newRun(31337, 'foundry');
    game.input.locked = true;
    game.player.award(1e6);
    for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
    calm();
    const valves = game.questProps.valves;
    out.foundryThreeValves = valves.length === 3 && game.questProps.parts.length === 0;
    at(valves[0].center);
    out.foundryNeedsPower = /NEEDS POWER/.test(prompt());
    game.turnOnPower();
    out.foundryPrompt = prompt() === 'OPEN THE STEAM VALVE';
    game.findInteractable().act();
    step(2);
    out.foundryClockRuns = game.quest.valvesOpen === 1 && /^1:1\d$/.test(prog(1)) && valves[0].open;
    game.quest.valveTimer = 0.05;
    step(6);
    out.foundryPressureLost = game.quest.valvesOpen === 0 && !valves[0].open && game.quest.valveTimer === 0;
    for (let i = 0; i < 3; i++) game.openValve(i);
    step(2);
    out.foundryHarvests = game.quest.stage === 'harvest' && game.questProps.ring.group.visible && game.quest.deviceOn;
    // A kill inside the ring feeds it; one out in the map does not.
    const c = game.questProps.bench.center;
    const spot = (() => {
      for (let a = 0; a < 16; a++) {
        const x = c.x + Math.cos((a / 16) * Math.PI * 2) * 6;
        const z = c.z + Math.sin((a / 16) * Math.PI * 2) * 6;
        if (game.grid.lineOfSight(c.x, c.z, x, z)) return { x, z };
      }
      return null;
    })();
    const near = game.pool.acquire('walker');
    near.spawn('walker', spot.x, spot.z, 100, 1, null, game.rng);
    near.state = 'hunt';
    game.damageEnemy(near, 500, false, false, { x: spot.x, y: 2, z: spot.z });
    const far = game.pool.acquire('walker');
    far.spawn('walker', game.layout.spawn.tx * 4 + 2, game.layout.spawn.tz * 4 + 2, 100, 1, null, game.rng);
    far.state = 'hunt';
    game.damageEnemy(far, 500, false, false, { x: far.x, y: 2, z: far.z });
    out.foundryOnlyNearKillsCount = game.quest.kills === 1;
    at(c);
    step(2);
    out.foundryCountShown = prog(2) === '1/20';

    // Sublevel 9: the vents stay locked until the keycard turns up.
    game.newRun(31337, 'labs');
    calm();
    game.turnOnPower();
    game.openValve(0);
    out.labsVentsLocked = game.quest.valvesOpen === 0;
    game.takePart(0);
    game.openValve(0);
    out.labsKeycardOpensThem = game.quest.valvesOpen === 1;

    // Threat: the same round is tougher further down.
    const health = {};
    for (const map of ['asylum', 'labs']) {
      game.newRun(31337, map);
      game.startRound(3);
      health[map] = game.plan.health;
    }
    out.laterChaptersHitHarder = health.labs > health.asylum * 1.4;
    game.newRun(31337, 'asylum');
    return out;
  });
  for (const [k, v] of Object.entries(jobs)) check(`jobs: ${k}`, v === true);

  // ------------------------------------------------------------- bosses
  const fights = await page.evaluate(() => {
    const { game } = window.__RZA;
    const out = {};
    for (const [map, id] of [['asylum', 'warden'], ['town', 'butcher'], ['foundry', 'furnace'], ['labs', 'patient0']]) {
      game.newRun(777, map);
      game.input.locked = true;
      game.player.award(1e6);
      for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
      game.pool.reset();
      game.roundPhase = 'clear';
      game.phaseTimer = 1e9;
      game.turnOnPower();
      game.quest.completeSteps();
      game.quest.bossTimer = 0;
      game.update(1 / 60);
      const boss = game.pool.boss;
      const r = { spawned: Boolean(boss && boss.active && boss.id === id), moves: [], hurt: 0, health: boss ? boss.maxHealth : 0 };
      if (!boss) { out[id] = r; continue; }
      // Put it inside, in sight of the player, and let it fight.
      let placed = false;
      for (let a = 0; a < 16 && !placed; a++) {
        const ang = (a / 16) * Math.PI * 2;
        for (const dist of [18, 14, 10]) {
          const x = game.player.x + Math.cos(ang) * dist;
          const z = game.player.z + Math.sin(ang) * dist;
          if (game.grid.lineOfSight(game.player.x, game.player.z, x, z) && game.grid.lineOfSight(x, z, x + 1.5, z) && game.grid.lineOfSight(x, z, x - 1.5, z)) {
            boss.x = x;
            boss.z = z;
            placed = true;
            break;
          }
        }
      }
      boss.target = null;
      boss.state = 'hunt';
      boss.y = 0;
      const seen = new Set();
      let taken = 0;
      for (let f = 0; f < 60 * 30; f++) {
        const before = game.player.health;
        game.update(1 / 60);
        if (game.player.health < before) taken += before - game.player.health;
        game.player.health = game.player.maxHealth;
        if (!game.player.alive) break;
        if (boss.currentAction === 'windup' && boss.pending) seen.add(boss.pending);
        if (boss.currentAction === 'summon') seen.add('summon');
      }
      r.moves = [...seen];
      r.hurt = Math.round(taken);
      r.placed = placed;
      if (id === 'furnace') {
        game.ignite(boss, 5);
        r.fireproof = boss.burning === 0;
      }
      out[id] = r;
    }
    return out;
  });
  for (const [id, r] of Object.entries(fights)) {
    check(`boss: ${id} arrives`, r.spawned, `${r.health} hp`);
    check(`boss: ${id} uses its moves`, r.moves.length >= 1, r.moves.join(', ') || 'none');
    check(`boss: ${id} hurts the player`, r.hurt > 0, `${r.hurt} damage in 30 s`);
    if (id === 'furnace') check('boss: fire does not hurt the furnace man', r.fireproof === true);
  }

  // ------------------------------------------------------ chapter select
  const select = await page.evaluate(() => {
    const { game } = window.__RZA;
    const shown = (id) => !document.getElementById(id).classList.contains('hidden');
    game.abandon();
    document.getElementById('btn-play').click();
    const out = { mapsOpen: shown('menu-maps') && !shown('menu-main') };
    const cards = [...document.querySelectorAll('#map-cards .card')];
    out.fourChapters = cards.length === 4;
    out.firstOpen = !cards[0].classList.contains('locked');
    out.escapedMarked = cards[0].classList.contains('done');
    out.secondOpenAfterEscape = !cards[1].classList.contains('locked');
    out.lastLocked = cards[3].classList.contains('locked');
    cards[3].click();
    out.lockedStaysShut = shown('menu-maps') && !shown('menu-brief');
    cards[1].click();
    out.briefingOpens = shown('menu-brief') && document.getElementById('brief-title').textContent === 'OUTBREAK';
    // The town's own four jobs, then the boss and the way out.
    out.briefingListsSteps = document.querySelectorAll('#brief-steps li').length === 6;
    out.briefingShowsThreat = /THREAT/.test(document.getElementById('brief-chapter').textContent);
    document.getElementById('btn-brief-back').click();
    out.backToChapters = shown('menu-maps');
    return out;
  });
  for (const [k, v] of Object.entries(select)) check(`chapters: ${k}`, v === true);

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
