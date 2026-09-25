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
import { GUN_IDS } from '../src/gfx/guns.ts';
import { Rng } from '../src/core/rng.ts';
import {
  BOX_POOL,
  WEAPONS,
  boxWeights,
  fireInterval,
  getWeapon,
  reloadDuration,
  shotDamage,
} from '../src/game/weapons.ts';
import {
  PERK_INFO,
  POWERUPS,
  enemyCount,
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

  it('builds six to eight themed rooms with at least one loop', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const L = generateLayout(seed);
      assert.ok(L.zones.length >= 6 && L.zones.length <= 8, `seed ${seed}: ${L.zones.length} rooms`);
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
    const base = shotDamage(w, { head: false, doubleTap: false, instaKill: false, packed: false });
    const head = shotDamage(w, { head: true, doubleTap: false, instaKill: false, packed: false });
    const packed = shotDamage(w, { head: false, doubleTap: false, instaKill: false, packed: true });
    assert.equal(base, w.damage);
    assert.equal(head, w.damage * w.headMult);
    assert.ok(packed > base);
    assert.ok(
      shotDamage(w, { head: false, doubleTap: false, instaKill: true, packed: false }) > 1e5,
    );
  });

  it('offers a mystery box pool that excludes the starter pistol', () => {
    assert.ok(BOX_POOL.length >= 5);
    assert.ok(!BOX_POOL.includes('sidearm'));
    assert.ok(!BOX_POOL.includes('knife'));
    assert.ok(BOX_POOL.includes('plasma'));
    assert.equal(boxWeights().length, BOX_POOL.length);
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
