import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MAP_H,
  MAP_W,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  T_VOID,
  T_WALL,
  type Layout,
  facingNormal,
  floodFloor,
  generateLayout,
  tileCenter,
  validateLayout,
  worldToTile,
  zoneAt,
} from '../src/world/mapdata.ts';
import { NavGrid } from '../src/world/grid.ts';
import { DEFAULT_KEYS, REBINDABLE, bindable, keyLabel } from '../src/core/input.ts';
import { GUN_IDS } from '../src/gfx/guns.ts';
import { Rng } from '../src/core/rng.ts';
import {
  BOX_POOL,
  PAP_MAX,
  RARITY_INFO,
  WEAPONS,
  boxWeights,
  fireInterval,
  getWeapon,
  magFor,
  papCost,
  reloadDuration,
  reserveFor,
  shotDamage,
  tierName,
} from '../src/game/weapons.ts';
import {
  PERK_INFO,
  POWERUPS,
  MAX_THREAT,
  enemyCount,
  enemyDamage,
  enemyHealth,
  enemySpeed,
  isHoundRound,
  maxAlive,
  maxHealth,
  planRound,
  roundMix,
  scoreForKill,
  spawnInterval,
} from '../src/game/rules.ts';

import { MAPS, MAP_ORDER } from '../src/world/maps.ts';
import { BOSS_DELAY, Quest } from '../src/game/quest.ts';
import { CHAPTERS, UNLOCK_ROUND, beatsFor } from '../src/game/story.ts';
import { defaultProgress, isUnlocked, loadProgress, nextMap, recordRun } from '../src/game/progress.ts';
import { BOSSES, bossHealth } from '../src/game/boss.ts';

/** Every generated asylum must pass every rule; sweep a few hundred of them. */
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('generated arenas', () => {
  it('passes every placement and connectivity rule for 300 seeds', () => {
    for (const seed of SEEDS) {
      const errs = validateLayout(generateLayout(seed));
      assert.deepEqual(errs, [], `seed ${seed}: ${errs.join('; ')}`);
    }
  });

  it('is deterministic: the same seed builds the same asylum', () => {
    const a = generateLayout(777);
    const b = generateLayout(777);
    assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
    assert.deepEqual(a.zones.map((z) => z.name), b.zones.map((z) => z.name));
    assert.deepEqual(a.wallBuys, b.wallBuys);
  });

  it('actually varies from run to run', () => {
    const shapes = new Set<string>();
    const starts = new Set<string>();
    for (const seed of SEEDS.slice(0, 60)) {
      const L = generateLayout(seed);
      shapes.add(Array.from(L.tiles).join(''));
      starts.add(L.zones.find((z) => z.id === L.spawnZone)?.theme ?? '');
    }
    assert.equal(shapes.size, 60, 'two seeds produced the same map');
    assert.ok(starts.size >= 3, 'the start room is always the same kind');
  });

  it('builds nine to twelve themed rooms with at least one loop', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const L = generateLayout(seed);
      assert.ok(L.zones.length >= 9 && L.zones.length <= 12, `seed ${seed}: ${L.zones.length} rooms`);
      // A spanning tree has rooms - 1 corridors; anything more is a loop to train in.
      assert.ok(L.corridors.length >= L.zones.length, `seed ${seed} has no loop`);
      assert.equal(new Set(L.zones.map((z) => z.name)).size, L.zones.length, 'duplicate room names');
      assert.equal(L.zones.find((z) => z.id === L.powerZone)?.theme, 'generator');
    }
  });

  it('keeps the space outside every window clear for the dead to walk in', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const L = generateLayout(seed);
      for (const b of L.barricades) {
        for (let step = 1; step <= 3; step++) {
          const t = L.tiles[(b.tz + b.dz * step) * MAP_W + (b.tx + b.dx * step)];
          assert.equal(t, T_VOID, `seed ${seed} ${b.id}: something outside at step ${step}`);
        }
      }
    }
  });

  it('prices doors by how deep into the asylum they lead', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const L = generateLayout(seed);
      for (const d of L.doors) {
        assert.ok(d.cost >= 750 && d.cost <= 1500 && d.cost % 250 === 0, `seed ${seed} ${d.id} costs ${d.cost}`);
        if (d.connects.includes(L.spawnZone)) assert.ok(d.cost <= 1000, `seed ${seed}: first door costs ${d.cost}`);
      }
    }
  });

  it('puts the power further from the start than the start room guns', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const L = generateLayout(seed);
      const open = Uint8Array.from(L.tiles);
      for (const d of L.doors) {
        for (let z = d.rect.z; z < d.rect.z + d.rect.h; z++) {
          for (let x = d.rect.x; x < d.rect.x + d.rect.w; x++) open[z * MAP_W + x] = T_FLOOR;
        }
      }
      const grid = new NavGrid(open);
      assert.ok(grid.buildFlowField(L.spawn.tx, L.spawn.tz, new Set()));
      // Measured at the switch: generator rooms can have a pillar in the middle.
      const power = grid.distanceAt(L.powerSwitch.tx, L.powerSwitch.tz);
      assert.ok(power > 0, `seed ${seed}: power switch unreachable`);
      assert.notEqual(L.powerZone, L.spawnZone);
      for (const w of L.wallBuys.filter((q) => q.zone === L.spawnZone)) {
        assert.ok(power > grid.distanceAt(w.tx, w.tz), `seed ${seed}: power is closer than the start room`);
      }
    }
  });

  it('round-trips world and tile coordinates', () => {
    const c = tileCenter(12, 7);
    const t = worldToTile(c.x, c.z);
    assert.deepEqual(t, { tx: 12, tz: 7 });
    assert.equal(c.x, 12.5 * TILE);
  });
});

/** A west wall of the start room with plain wall behind it, for the collision tests. */
function startWall(L: Layout): { tx: number; tz: number; wallTx: number } {
  const z = L.zones.find((q) => q.id === L.spawnZone);
  if (!z) throw new Error('no start zone');
  for (let tz = z.rect.z + 1; tz < z.rect.z + z.rect.h - 1; tz++) {
    const tx = z.rect.x;
    if (L.tiles[tz * MAP_W + tx] === T_FLOOR && L.tiles[tz * MAP_W + tx - 1] === T_WALL) return { tx, tz, wallTx: tx - 1 };
  }
  throw new Error('start room has no plain west wall');
}

describe('collision and pathing', () => {
  const L = generateLayout(4242);
  const grid = new NavGrid(L.tiles);
  const wall = startWall(L);

  it('pushes a body out of a wall instead of letting it through', () => {
    const wallFace = wall.tx * TILE;
    const r = 0.55;
    const res = grid.resolveCircle(wallFace - 0.2, (wall.tz + 0.5) * TILE, r);
    assert.ok(res.hitWall, 'expected a wall contact');
    assert.ok(res.x >= wallFace - 1e-6, `body ended inside the wall at x=${res.x}`);
  });

  it('leaves a body in open space untouched', () => {
    const c = tileCenter(L.spawn.tx, L.spawn.tz);
    const res = grid.resolveCircle(c.x, c.z, 0.55);
    assert.equal(res.hitWall, false);
    assert.ok(Math.abs(res.x - c.x) < 1e-9 && Math.abs(res.z - c.z) < 1e-9);
  });

  it('stops a raycast at the first solid tile', () => {
    const from = tileCenter(wall.tx + 1, wall.tz);
    const hit = grid.raycast(from.x, from.z, -1, 0, 200);
    assert.ok(hit.hit, 'ray should have hit the west wall');
    assert.equal(hit.tx, wall.wallTx);
    assert.ok(Math.abs(hit.x - wall.tx * TILE) < 0.001, `hit at x=${hit.x}`);
    assert.equal(hit.nx, 1);
  });

  it('reports line of sight honestly', () => {
    const z = L.zones.find((q) => q.id === L.spawnZone);
    const other = L.zones.find((q) => q.id !== L.spawnZone);
    if (!z || !other) throw new Error('need two zones');
    const a = tileCenter(z.rect.x + 1, z.rect.z + 1);
    const b = tileCenter(z.rect.x + z.rect.w - 2, z.rect.z + 1);
    assert.equal(grid.lineOfSight(a.x, a.z, b.x, b.z), true);
    const far = tileCenter(other.rect.x + (other.rect.w >> 1), other.rect.z + (other.rect.h >> 1));
    assert.equal(grid.lineOfSight(a.x, a.z, far.x, far.z), false);
  });

  it('builds a flow field that strictly descends to the goal from everywhere', () => {
    assert.equal(grid.buildFlowField(L.spawn.tx, L.spawn.tz, new Set()), true);
    let steps = 0;
    for (const start of floodFloor(L.tiles, L.spawn.tx, L.spawn.tz)) {
      let tx = start % MAP_W;
      let tz = Math.floor(start / MAP_W);
      let guard = 0;
      while (!(tx === L.spawn.tx && tz === L.spawn.tz)) {
        const f = grid.flowAt(tx, tz);
        if (!f) throw new Error(`no flow at ${tx},${tz}`);
        const before = grid.distanceAt(tx, tz);
        tx += f.dx;
        tz += f.dz;
        assert.equal(grid.distanceAt(tx, tz), before - 1, 'flow must strictly descend');
        assert.ok(++guard < 500, 'flow field looped');
        steps++;
      }
    }
    assert.ok(steps > 0);
  });

  it('will not path through an intact barricade but will through a torn one', () => {
    const b = L.barricades[0];
    const torn = new Set<number>();
    assert.equal(grid.solidForZombie(b.tx, b.tz, torn), true);
    torn.add(grid.idx(b.tx, b.tz));
    assert.equal(grid.solidForZombie(b.tx, b.tz, torn), false);
  });

  it('refuses to build a field on a solid goal', () => {
    assert.equal(new NavGrid(L.tiles).buildFlowField(0, 0, new Set()), false);
  });

  it('knows which room every prop stands in and what is behind it', () => {
    for (const p of [...L.perks, ...L.wallBuys, ...L.boxPads, L.powerSwitch, L.pack]) {
      assert.equal(zoneAt(L, p.tx, p.tz), p.zone);
      const { nx, nz } = facingNormal(p.facing);
      assert.equal(L.tiles[(p.tz - nz) * MAP_W + (p.tx - nx)], T_WALL);
    }
    assert.ok(L.doors.every((d) => L.tiles[d.rect.z * MAP_W + d.rect.x] === T_DOOR));
    assert.ok(L.barricades.every((b) => L.tiles[b.tz * MAP_W + b.tx] === T_BARRICADE));
    assert.equal(L.tiles.length, MAP_W * MAP_H);
  });
});

describe('round scaling', () => {
  it('matches the canonical health curve', () => {
    assert.equal(enemyHealth(1), 150);
    assert.equal(enemyHealth(9), 950);
    assert.ok(enemyHealth(10) > 950);
  });

  it('never gets easier as rounds climb', () => {
    for (let r = 2; r <= 60; r++) {
      assert.ok(enemyHealth(r) >= enemyHealth(r - 1), `health dipped at round ${r}`);
      assert.ok(enemySpeed(r, 'walker') >= enemySpeed(r - 1, 'walker'));
    }
    // Hound rounds are paced on their own curve, so compare like with like.
    let prevNormal = spawnInterval(1);
    let prevHound = spawnInterval(5);
    for (let r = 2; r <= 60; r++) {
      if (isHoundRound(r)) {
        assert.ok(spawnInterval(r) <= prevHound, `hound spawns slowed at round ${r}`);
        prevHound = spawnInterval(r);
      } else {
        assert.ok(spawnInterval(r) <= prevNormal, `spawns slowed at round ${r}`);
        prevNormal = spawnInterval(r);
      }
    }
  });

  it('keeps enemy counts and concurrency bounded', () => {
    for (let r = 1; r <= 100; r++) {
      const plan = planRound(r);
      assert.ok(plan.total >= 1, `round ${r} has no enemies`);
      assert.ok(plan.total <= 74, `round ${r} spawns ${plan.total}`);
      assert.ok(plan.maxAlive <= 26 && plan.maxAlive >= 1);
      assert.ok(plan.maxAlive <= plan.total + 10);
      assert.ok(plan.interval > 0);
      assert.ok(Number.isFinite(plan.health) && plan.health > 0);
    }
    assert.equal(enemyCount(1), 6);
    assert.ok(enemyCount(10) > enemyCount(5));
    assert.ok(maxAlive(30) <= 26);
  });

  it('runs a hound round every fifth round', () => {
    assert.equal(isHoundRound(4), false);
    assert.equal(isHoundRound(5), true);
    assert.equal(isHoundRound(10), true);
    assert.equal(planRound(10).mix[0].kind, 'hound');
  });

  it('keeps the enemy mix a valid distribution', () => {
    for (let r = 1; r <= 40; r++) {
      const mix = roundMix(r);
      const sum = mix.reduce((a, m) => a + m.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `round ${r} mix sums to ${sum}`);
      for (const m of mix) assert.ok(m.weight >= 0);
    }
    assert.equal(roundMix(2).find((m) => m.kind === 'runner')?.weight, 0);
    assert.ok((roundMix(19).find((m) => m.kind === 'brute')?.weight ?? 0) > 0);
  });
});

describe('scoring and perks', () => {
  it('pays more for a headshot than a body shot', () => {
    assert.ok(scoreForKill('head', false) > scoreForKill('body', false));
    assert.equal(scoreForKill('body', true), scoreForKill('body', false) * 2);
  });

  it('raises the health ceiling with Juggernog', () => {
    assert.ok(maxHealth(true) > maxHealth(false));
  });

  it('gates every machine but Quick Revive behind the power', () => {
    assert.equal(PERK_INFO.revive.needsPower, false);
    for (const p of Object.values(PERK_INFO)) {
      if (p.id !== 'revive') assert.equal(p.needsPower, true, `${p.id} should need power`);
      assert.ok(p.cost > 0);
    }
  });

  it('gives every power-up a positive weight', () => {
    for (const p of Object.values(POWERUPS)) assert.ok(p.weight > 0);
  });
});

describe('weapons', () => {
  it('describes every weapon completely', () => {
    for (const w of Object.values(WEAPONS)) {
      assert.ok(w.name.length > 0, `${w.id} has no name`);
      assert.ok(GUN_IDS.includes(w.id), `${w.id} has no model`);
      assert.ok(w.rpm > 0 && w.magSize > 0, `${w.id} has bad fire data`);
      assert.ok(w.range > 0);
      assert.ok(w.reserveMax >= w.magSize, `${w.id} reserve smaller than a magazine`);
    }
  });

  it('makes Double Tap and Speed Cola actually do something', () => {
    const rifle = getWeapon('nailrifle');
    assert.ok(fireInterval(rifle, true) < fireInterval(rifle, false));
    assert.ok(reloadDuration(rifle, true) < reloadDuration(rifle, false));
  });

  it('stacks damage modifiers in the right order', () => {
    const w = getWeapon('sidearm');
    const base = shotDamage(w, { head: false, doubleTap: false, instaKill: false, tier: 0 });
    const head = shotDamage(w, { head: true, doubleTap: false, instaKill: false, tier: 0 });
    const packed = shotDamage(w, { head: false, doubleTap: false, instaKill: false, tier: 1 });
    assert.equal(base, w.damage);
    assert.equal(head, w.damage * w.headMult);
    assert.ok(packed > base);
    assert.ok(
      shotDamage(w, { head: false, doubleTap: false, instaKill: true, tier: 0 }) > 1e5,
    );
  });

  it('offers a mystery box pool that excludes the starter pistol', () => {
    assert.ok(BOX_POOL.length >= 5);
    assert.ok(!BOX_POOL.includes('sidearm'));
    assert.ok(!BOX_POOL.includes('knife'));
    assert.ok(BOX_POOL.includes('plasma'));
    assert.equal(boxWeights().length, BOX_POOL.length);
  });

  it('rolls the box by rarity, with a 5% shot at a legendary', () => {
    const w = boxWeights();
    const total = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `box odds sum to ${total}`);
    const legendary = BOX_POOL.filter((id, i) => WEAPONS[id].rarity === 'legendary' && w[i] > 0);
    assert.ok(legendary.length >= 3, 'the box needs legendary guns');
    const share = BOX_POOL.reduce((a, id, i) => a + (WEAPONS[id].rarity === 'legendary' ? w[i] : 0), 0);
    assert.ok(Math.abs(share - RARITY_INFO.legendary.odds) < 1e-9);
    for (const id of BOX_POOL) assert.ok(WEAPONS[id].rarity, `${id} has no rarity`);
  });

  it('never offers a gun the player is already carrying', () => {
    const owned = ['boomstick', 'stormcaller'];
    const w = boxWeights(owned);
    for (const id of owned) assert.equal(w[BOX_POOL.indexOf(id)], 0);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it('packs a gun three tiers deep, each one stronger', () => {
    const w = getWeapon('trench');
    let prev = 0;
    for (let tier = 0; tier <= PAP_MAX; tier++) {
      const d = shotDamage(w, { head: false, doubleTap: false, instaKill: false, tier });
      assert.ok(d > prev, `tier ${tier} is not stronger`);
      prev = d;
      assert.ok(magFor(w, tier) >= w.magSize);
      assert.ok(reserveFor(w, tier) >= w.reserveMax);
    }
    assert.ok(magFor(w, 3) > magFor(w, 1));
    assert.ok(papCost(0) > 0 && papCost(2) >= papCost(1));
    assert.equal(tierName('X', 0), 'X');
    assert.notEqual(tierName('X', 2), tierName('X', 1));
  });
});

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });

  it('stays inside [0,1) and respects int bounds', () => {
    const r = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      assert.ok(v >= 0 && v < 1);
      const n = r.int(6);
      assert.ok(Number.isInteger(n) && n >= 0 && n < 6);
    }
  });

  it('honours weights', () => {
    const r = new Rng(9);
    const counts = [0, 0, 0];
    for (let i = 0; i < 6000; i++) counts[r.weighted([0, 1, 3])]++;
    assert.equal(counts[0], 0, 'a zero weight must never be picked');
    assert.ok(counts[2] > counts[1] * 2, `expected ~3:1, got ${counts[2]}:${counts[1]}`);
  });
});

describe('maps', () => {
  it('every map generates valid layouts across many seeds', () => {
    for (const id of MAP_ORDER) {
      for (let seed = 1; seed <= 60; seed++) {
        const L = generateLayout(seed, MAPS[id]);
        assert.equal(L.map, id);
        const errs = validateLayout(L);
        assert.deepEqual(errs, [], `${id} seed ${seed}: ${errs.join('; ')}`);
      }
    }
  });

  it('the new maps are much bigger than the asylum', () => {
    const floorOf = (id: keyof typeof MAPS): number => {
      let total = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const L = generateLayout(seed, MAPS[id]);
        for (const t of L.tiles) if (t === T_FLOOR) total++;
      }
      return total / 20;
    };
    const asylum = floorOf('asylum');
    for (const id of ['town', 'foundry', 'labs'] as const) {
      assert.ok(floorOf(id) > asylum * 1.2, `${id} should have more floor than the asylum`);
    }
  });

  it('parts are spread across three rooms and the exit is in the start room', () => {
    for (const id of MAP_ORDER) {
      const L = generateLayout(99, MAPS[id]);
      assert.equal(L.parts.length, 3);
      assert.equal(new Set(L.parts.map((p) => p.zone)).size, 3);
      assert.equal(L.exit.zone, L.spawnZone);
      assert.notEqual(L.workbench.zone, L.spawnZone);
    }
  });

  it('valve spots are out in the map, spread across rooms where there are enough', () => {
    for (const id of MAP_ORDER) {
      for (let seed = 1; seed <= 20; seed++) {
        const L = generateLayout(seed, MAPS[id]);
        assert.equal(L.spots.length, 3);
        assert.ok(L.spots.every((p) => p.zone !== L.spawnZone));
        const rooms = L.zones.length - 1;
        if (rooms >= 3) assert.equal(new Set(L.spots.map((p) => p.zone)).size, 3, `${id} seed ${seed}`);
      }
    }
  });
});

describe('story and objectives', () => {
  it('every map has a chapter with everything the run needs', () => {
    MAP_ORDER.forEach((id, i) => {
      const c = CHAPTERS[id];
      assert.equal(c.map, id);
      assert.equal(c.number, i + 1);
      assert.ok(c.steps.length >= 3, `${id} has too little to do`);
      assert.equal(c.steps[0].kind, 'power', `${id} should start with the power`);
      assert.ok(c.briefing.length > 0 && c.ending.length > 0);
      for (const b of beatsFor(c.steps)) assert.ok(c.radio[b]?.length, `${id} has nothing to say about ${b}`);
      assert.ok(BOSSES[c.boss], `${id} names a boss that does not exist`);
      const parts = c.steps.find((s) => s.kind === 'parts');
      if (parts) assert.ok(parts.names.length >= 1 && parts.names.length <= 3, 'a layout only has three part crates');
    });
  });

  it('no two chapters ask for the same jobs', () => {
    const chains = MAP_ORDER.map((id) => CHAPTERS[id].steps.map((s) => s.kind).join(' > '));
    assert.equal(new Set(chains).size, chains.length, chains.join(' | '));
  });

  it('each chapter asks more of you than the last', () => {
    // More jobs, or harder versions of them: every chapter after the first adds a timed or held job.
    const weight = (id: (typeof MAP_ORDER)[number]): number => CHAPTERS[id].steps.reduce((n, s) => {
      if (s.kind === 'valves') return n + 2 + 60 / s.window;
      if (s.kind === 'harvest') return n + 2 + s.kills / 20;
      if (s.kind === 'defend') return n + 2 + s.seconds / 60;
      return n + 1;
    }, 0);
    for (let i = 1; i < MAP_ORDER.length; i++) {
      assert.ok(weight(MAP_ORDER[i]) > weight(MAP_ORDER[i - 1]), `${MAP_ORDER[i]} is no harder than ${MAP_ORDER[i - 1]}`);
    }
    // The same valves get less time, the same defence lasts longer.
    assert.ok((CHAPTERS.labs.steps.find((s) => s.kind === 'valves') as { window: number }).window
      < (CHAPTERS.foundry.steps.find((s) => s.kind === 'valves') as { window: number }).window);
    assert.ok((CHAPTERS.labs.steps.find((s) => s.kind === 'defend') as { seconds: number }).seconds
      > (CHAPTERS.town.steps.find((s) => s.kind === 'defend') as { seconds: number }).seconds);
  });

  it('asylum: power, parts and build, then boss and escape', () => {
    const q = new Quest('asylum');
    assert.equal(q.stage, 'power');
    assert.equal(q.canBuild, false);
    // Parts can be found before the power is on, but nothing can be built.
    assert.deepEqual(q.takePart(1), ['part']);
    assert.deepEqual(q.takePart(1), [], 'a part is only picked up once');
    assert.equal(q.stage, 'power');
    assert.deepEqual(q.powerOn(), ['power']);
    assert.deepEqual(q.powerOn(), []);
    assert.equal(q.stage, 'parts');
    q.takePart(0);
    assert.equal(q.canBuild, false);
    assert.deepEqual(q.takePart(2), ['parts']);
    assert.equal(q.stage, 'build');
    assert.deepEqual(q.build(), ['built']);
    assert.deepEqual(q.build(), [], 'it is only built once');
    assert.equal(q.boss, 'coming');
    assert.equal(q.canEscape, false);
    q.tick(BOSS_DELAY / 2);
    assert.equal(q.bossDue, false);
    q.tick(BOSS_DELAY);
    assert.equal(q.bossDue, true);
    q.tick(0.1);
    assert.equal(q.bossDue, true, 'keeps asking until the boss actually turns up');
    assert.deepEqual(q.bossArrived(), ['boss']);
    assert.equal(q.bossDue, false);
    assert.equal(q.stage, 'boss');
    assert.deepEqual(q.escape(), [], 'no escaping with the boss alive');
    assert.deepEqual(q.bossKilled(), ['bossDown']);
    assert.equal(q.stage, 'escape');
    assert.deepEqual(q.escape(), ['escaped']);
    assert.equal(q.stage, 'done');
  });

  it('town: the beacon has to be defended, and only counts while you stay near it', () => {
    const q = new Quest('town');
    assert.equal(q.parts.length, 2);
    q.powerOn();
    q.takePart(0);
    q.takePart(1);
    assert.deepEqual(q.build(), ['built', 'defend']);
    assert.equal(q.stage, 'defend');
    assert.equal(q.defending, true);
    assert.equal(q.boss, 'none', 'the boss waits for the defence');
    assert.deepEqual(q.tick(20, false), [], 'wandering off holds nothing');
    assert.equal(q.held, 0);
    assert.equal(q.objectives()[3].progress, 'GET BACK TO IT');
    assert.equal(q.objectives()[3].alert, true);
    assert.deepEqual(q.tick(31, true), ['defendHalf']);
    assert.equal(q.objectives()[3].progress, '0:29');
    assert.deepEqual(q.tick(29.5, true), ['defended']);
    assert.equal(q.boss, 'coming');
    assert.equal(q.stage, 'boss');
  });

  it('foundry: valves against the clock, then feed the crucible', () => {
    const q = new Quest('foundry');
    assert.equal(q.parts.length, 0);
    assert.equal(q.valves.length, 3);
    assert.deepEqual(q.openValve(0), [], 'no valves before the turbines');
    q.powerOn();
    assert.equal(q.stage, 'valves');
    assert.deepEqual(q.openValve(0), ['valve']);
    assert.deepEqual(q.openValve(0), [], 'a valve only opens once');
    assert.equal(q.valveTimer, 75);
    assert.match(q.objectives()[1].text, /1\/3/);
    assert.equal(q.objectives()[1].progress, '1:15');
    q.openValve(2);
    // Too slow: they all slam shut and the clock stops.
    assert.deepEqual(q.tick(80), ['valvesLost']);
    assert.equal(q.valvesOpen, 0);
    assert.equal(q.valveTimer, 0);
    assert.deepEqual(q.tick(30), [], 'no clock until the first one is open again');
    // Fast enough this time.
    q.openValve(1);
    q.tick(20);
    q.openValve(0);
    assert.equal(q.deviceOn, false);
    assert.deepEqual(q.openValve(2), ['valves', 'harvest']);
    assert.equal(q.deviceOn, true, 'the crucible lights');
    assert.equal(q.stage, 'harvest');
    const beats: string[] = [];
    for (let i = 0; i < 20; i++) beats.push(...q.harvest());
    assert.deepEqual(beats, ['harvestHalf', 'harvested']);
    assert.deepEqual(q.harvest(), [], 'full is full');
    assert.equal(q.boss, 'coming');
  });

  it('labs: the keycard, then the vents, then hold the purge', () => {
    const q = new Quest('labs');
    q.powerOn();
    assert.equal(q.canOpenValves, false, 'the vents are locked without the keycard');
    assert.deepEqual(q.openValve(0), []);
    assert.deepEqual(q.takePart(0), ['parts']);
    assert.equal(q.objectives()[1].text, 'FIND THE ACCESS KEYCARD');
    for (let i = 0; i < 2; i++) q.openValve(i);
    assert.equal(q.valveTimer, 50);
    assert.deepEqual(q.openValve(2), ['valves', 'defend']);
    assert.equal(q.stage, 'defend');
    q.tick(90, true);
    assert.equal(q.boss, 'coming');
  });

  it('completeSteps skips straight to the boss on every chapter', () => {
    for (const id of MAP_ORDER) {
      const q = new Quest(id);
      q.completeSteps();
      assert.equal(q.boss, 'coming', id);
      assert.ok(q.objectives().every((o) => !o.done) && q.objectives()[0].text.startsWith('SOMETHING'));
    }
  });

  it('shows the objectives that matter right now', () => {
    const q = new Quest('asylum');
    const first = q.objectives();
    assert.equal(first.length, 3);
    assert.ok(first.every((o) => !o.done));
    q.powerOn();
    assert.equal(q.objectives()[0].done, true);
    q.takePart(0);
    assert.match(q.objectives()[1].text, /1\/3/);
    q.takePart(1);
    q.takePart(2);
    q.build();
    q.tick(BOSS_DELAY);
    q.bossArrived();
    assert.match(q.objectives()[0].text, new RegExp(CHAPTERS.asylum.bossName));
    q.bossKilled();
    assert.match(q.objectives()[0].text, new RegExp(CHAPTERS.asylum.exit));
  });
});

describe('unlocks', () => {
  it('starts with only the first map open', () => {
    const p = defaultProgress();
    assert.equal(isUnlocked(p, 'asylum'), true);
    for (const id of MAP_ORDER.slice(1)) assert.equal(isUnlocked(p, id), false);
  });

  it('escaping a map opens the next one', () => {
    const p = defaultProgress();
    const r = recordRun(p, 'asylum', { round: 6, kills: 80, points: 9000, escaped: true });
    assert.equal(r.unlocked, 'town');
    assert.equal(isUnlocked(p, 'town'), true);
    assert.equal(isUnlocked(p, 'foundry'), false);
    assert.equal(p.records.asylum?.escaped, true);
    assert.equal(p.records.asylum?.fastestEscape, 6);
    // Doing it again unlocks nothing new.
    assert.equal(recordRun(p, 'asylum', { round: 4, kills: 50, points: 5000, escaped: true }).unlocked, null);
    assert.equal(p.records.asylum?.fastestEscape, 4);
  });

  it('surviving long enough also opens the next map', () => {
    const p = defaultProgress();
    assert.equal(recordRun(p, 'asylum', { round: UNLOCK_ROUND - 1, kills: 1, points: 1, escaped: false }).unlocked, null);
    assert.equal(recordRun(p, 'asylum', { round: UNLOCK_ROUND, kills: 1, points: 1, escaped: false }).unlocked, 'town');
  });

  it('keeps the best round per map', () => {
    const p = defaultProgress();
    recordRun(p, 'asylum', { round: 9, kills: 100, points: 20000, escaped: false });
    const r = recordRun(p, 'asylum', { round: 5, kills: 40, points: 4000, escaped: false });
    assert.equal(r.best, false);
    assert.equal(p.records.asylum?.bestRound, 9);
  });

  it('the last map unlocks nothing', () => {
    assert.equal(nextMap('labs'), null);
    const p = defaultProgress();
    assert.equal(recordRun(p, 'labs', { round: 30, kills: 1, points: 1, escaped: true }).unlocked, null);
  });
});

describe('bosses', () => {
  it('each boss is tougher than the last', () => {
    const order = MAP_ORDER.map((id) => BOSSES[CHAPTERS[id].boss].health);
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1]);
  });

  it('scale with the round they turn up in', () => {
    for (const id of Object.keys(BOSSES) as (keyof typeof BOSSES)[]) {
      assert.ok(bossHealth(id, 3) >= BOSSES[id].health * 0.6, 'an early boss is still a boss');
      assert.ok(bossHealth(id, 20) > bossHealth(id, 10));
      assert.ok(bossHealth(id, 10) > bossHealth(id, 5));
      assert.ok(bossHealth(id, 10) > enemyHealth(10) * 15, 'a boss is worth many zombies');
    }
  });
});

describe('threat', () => {
  it('every chapter is harder than the one before', () => {
    for (let t = 1; t <= MAX_THREAT; t++) {
      for (const r of [1, 5, 9, 15, 25]) {
        assert.ok(enemyHealth(r, t) > enemyHealth(r, t - 1), `health at round ${r}`);
        assert.ok(enemyCount(r, t) >= enemyCount(r, t - 1), `count at round ${r}`);
        assert.ok(spawnInterval(r, t) <= spawnInterval(r, t - 1), `interval at round ${r}`);
        assert.ok(maxAlive(r, t) >= maxAlive(r, t - 1), `max alive at round ${r}`);
        assert.ok(enemySpeed(r, 'walker', t) > enemySpeed(r, 'walker', t - 1), `speed at round ${r}`);
        assert.ok(enemyDamage('walker', t) > enemyDamage('walker', t - 1));
      }
    }
    // Sublevel 9's first round is a real fight, not a massacre.
    assert.ok(enemyHealth(1, MAX_THREAT) < enemyHealth(4));
  });

  it('runners and brutes arrive earlier in the later chapters', () => {
    const firstRound = (kind: string, threat: number): number => {
      for (let r = 1; r < 40; r++) {
        if (roundMix(r, threat).some((m) => m.kind === kind && m.weight > 0)) return r;
      }
      return 99;
    };
    assert.ok(firstRound('runner', MAX_THREAT) < firstRound('runner', 0));
    assert.ok(firstRound('brute', MAX_THREAT) < firstRound('brute', 0));
  });

  it('keeps the pool from running dry at any threat', () => {
    for (let t = 0; t <= MAX_THREAT; t++) {
      for (let r = 1; r <= 100; r++) assert.ok(planRound(r, t).maxAlive <= 28);
    }
  });

  it('each chapter carries its own threat', () => {
    MAP_ORDER.forEach((id, i) => assert.equal(new Quest(id).threat, i));
  });
});

describe('key bindings', () => {
  it('names every key the way a player would read it', () => {
    assert.equal(keyLabel('KeyW'), 'W');
    assert.equal(keyLabel('Digit1'), '1');
    assert.equal(keyLabel('Space'), 'SPACE');
    assert.equal(keyLabel('ShiftLeft'), 'L SHIFT');
    assert.equal(keyLabel('ArrowUp'), 'UP');
    assert.equal(keyLabel('Numpad0'), 'NUM 0');
    assert.equal(keyLabel('Comma'), ',');
    // Nothing comes out blank, whatever the keyboard sends.
    assert.ok(keyLabel('IntlBackslash').length > 0);
  });

  it('every action has a default, and every offered action is real', () => {
    for (const { action, name } of REBINDABLE) {
      assert.ok(DEFAULT_KEYS[action]?.length, `${action} has no default key`);
      assert.ok(name.length > 0);
    }
    // Pause is deliberately not on offer: Esc is the way out of every screen.
    assert.ok(!REBINDABLE.some((r) => r.action === 'pause'));
  });

  it('no key does two jobs out of the box', () => {
    const seen = new Map<string, string>();
    for (const [action, codes] of Object.entries(DEFAULT_KEYS)) {
      for (const code of codes) {
        assert.equal(seen.get(code), undefined, `${code} is bound to both ${seen.get(code)} and ${action}`);
        seen.set(code, action);
      }
    }
  });

  it('will not hand over the keys the game or the browser needs', () => {
    for (const code of ['Escape', 'F5', 'F11', 'F12', 'MetaLeft']) {
      assert.equal(bindable(code), false, `${code} should not be bindable`);
    }
    assert.equal(bindable(''), false);
    assert.equal(bindable('KeyZ'), true);
    // Everything the defaults use must itself be bindable, or a reset would drop it.
    for (const codes of Object.values(DEFAULT_KEYS)) {
      for (const code of codes) {
        if (code === 'Escape') continue;
        assert.ok(bindable(code), `default key ${code} is not bindable`);
      }
    }
  });
});

describe('saved progress', () => {
  /** Stands in for localStorage, which node has no opinion about. */
  const fakeStorage = (value: string | null) => ({
    getItem: () => value,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });

  const loadFrom = (raw: string | null): ReturnType<typeof loadProgress> => {
    const g = globalThis as { localStorage?: unknown };
    const had = 'localStorage' in g;
    const before = g.localStorage;
    g.localStorage = fakeStorage(raw);
    try {
      return loadProgress();
    } finally {
      if (had) g.localStorage = before;
      else delete g.localStorage;
    }
  };

  it('a fresh player gets only the first chapter', () => {
    assert.deepEqual(loadFrom(null).unlocked, [MAP_ORDER[0]]);
  });

  it('reads back what it saved', () => {
    const p = defaultProgress();
    recordRun(p, 'asylum', { round: 12, kills: 200, points: 30000, escaped: true });
    const back = loadFrom(JSON.stringify(p));
    assert.deepEqual(back.unlocked, p.unlocked);
    assert.deepEqual(back.records.asylum, p.records.asylum);
  });

  it('nonsense in storage does not become nonsense on the chapter cards', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"records":7}', '{"unlocked":"town"}']) {
      const p = loadFrom(raw);
      assert.deepEqual(p.unlocked, [MAP_ORDER[0]], raw);
      assert.deepEqual(p.records, {}, raw);
    }
  });

  it('a half-written record is rebuilt rather than trusted', () => {
    const p = loadFrom(JSON.stringify({
      unlocked: ['asylum', 'town', 'nowhere'],
      records: { asylum: { bestRound: 'lots', escaped: 'yes', fastestEscape: -3 } },
    }));
    // A map that no longer exists is dropped; the real ones survive.
    assert.deepEqual(p.unlocked, ['asylum', 'town']);
    const rec = p.records.asylum;
    assert.ok(rec);
    // Every number is a number, and nothing claims an escape it cannot back up.
    for (const n of [rec.bestRound, rec.bestKills, rec.bestPoints, rec.fastestEscape]) {
      assert.equal(Number.isFinite(n), true);
      assert.ok(n >= 0);
    }
    assert.equal(rec.escaped, false);
    assert.equal(rec.fastestEscape, 0);
  });

  it('a record only keeps a fastest escape if it ever escaped', () => {
    const p = loadFrom(JSON.stringify({
      records: { asylum: { bestRound: 9, escaped: false, fastestEscape: 4 } },
    }));
    assert.equal(p.records.asylum?.fastestEscape, 0);
  });

  it('the same round with more points is still a new best', () => {
    const p = defaultProgress();
    recordRun(p, 'asylum', { round: 8, kills: 90, points: 10000, escaped: false });
    assert.equal(recordRun(p, 'asylum', { round: 8, kills: 95, points: 14000, escaped: false }).best, true);
    assert.equal(p.records.asylum?.bestPoints, 14000);
    // A worse run leaves the record alone.
    assert.equal(recordRun(p, 'asylum', { round: 8, kills: 10, points: 900, escaped: false }).best, false);
    assert.equal(p.records.asylum?.bestPoints, 14000);
  });
});
