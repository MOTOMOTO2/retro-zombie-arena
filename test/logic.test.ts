import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BARRICADES,
  BOX_PADS,
  DOORS,
  MAP_W,
  PERKS,
  PLAYER_SPAWN,
  POWER_SWITCH,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  T_WALL,
  WALL_BUYS,
  ZONES,
  buildTileMap,
  tileCenter,
  worldToTile,
  zoneAt,
} from '../src/world/mapdata.ts';
import { NavGrid } from '../src/world/grid.ts';
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

describe('arena layout', () => {
  const map = buildTileMap();
  const grid = new NavGrid(map);

  it('has a floor tile under the player spawn', () => {
    assert.equal(map[PLAYER_SPAWN.tz * MAP_W + PLAYER_SPAWN.tx], T_FLOOR);
  });

  it('puts every barricade on a wall-line tile with floor inside it', () => {
    for (const b of BARRICADES) {
      assert.equal(map[b.tz * MAP_W + b.tx], T_BARRICADE, `${b.id} is not a barricade tile`);
      const inside = map[(b.tz - b.dz) * MAP_W + (b.tx - b.dx)];
      assert.equal(inside, T_FLOOR, `${b.id} does not open into the room`);
    }
  });

  it('hangs every wall buy on a real wall', () => {
    for (const w of WALL_BUYS) {
      assert.ok(WEAPONS[w.weapon], `wall buy references unknown weapon ${w.weapon}`);
      assert.equal(map[w.tz * MAP_W + w.tx], T_FLOOR, `${w.weapon} pad is not floor`);
      const nx = Math.round(Math.sin(w.facing));
      const nz = Math.round(Math.cos(w.facing));
      assert.equal(
        map[(w.tz - nz) * MAP_W + (w.tx - nx)],
        T_WALL,
        `${w.weapon} has no wall behind it`,
      );
    }
  });

  it('stands every machine and pad on open floor', () => {
    const props = [
      ...PERKS.map((p) => ({ what: p.perk, tx: p.tx, tz: p.tz })),
      ...BOX_PADS.map((p) => ({ what: 'box', tx: p.tx, tz: p.tz })),
      { what: 'power', tx: POWER_SWITCH.tx, tz: POWER_SWITCH.tz },
    ];
    for (const p of props) {
      assert.equal(map[p.tz * MAP_W + p.tx], T_FLOOR, `${p.what} is inside geometry`);
    }
  });

  it('gives every door open floor on both faces', () => {
    for (const d of DOORS) {
      assert.equal(map[d.rect.z * MAP_W + d.rect.x], T_DOOR, `${d.id} is not a door tile`);
      const nx = d.axis === 'z' ? 1 : 0;
      const nz = d.axis === 'z' ? 0 : 1;
      const before = map[(d.rect.z - nz) * MAP_W + (d.rect.x - nx)];
      const after = map[(d.rect.z + nz * d.rect.h) * MAP_W + (d.rect.x + nx * d.rect.w)];
      assert.equal(before, T_FLOOR, `${d.id} front face is blocked`);
      assert.equal(after, T_FLOOR, `${d.id} back face is blocked`);
    }
  });

  it('seals the spawn room until a door is bought', () => {
    const reach = grid.reachable(PLAYER_SPAWN.tx, PLAYER_SPAWN.tz);
    for (const t of reach) {
      const zone = zoneAt(t % MAP_W, Math.floor(t / MAP_W));
      assert.ok(zone === 'lobby' || zone === null, 'spawn room leaks into another zone');
    }
  });

  it('opens up the whole asylum once every door is bought', () => {
    const open = new NavGrid(map);
    for (const d of DOORS) {
      for (let z = d.rect.z; z < d.rect.z + d.rect.h; z++) {
        for (let x = d.rect.x; x < d.rect.x + d.rect.w; x++) open.set(x, z, T_FLOOR);
      }
    }
    const reach = open.reachable(PLAYER_SPAWN.tx, PLAYER_SPAWN.tz);
    for (const zone of ZONES) {
      const c = {
        x: zone.rect.x + (zone.rect.w >> 1),
        z: zone.rect.z + (zone.rect.h >> 1),
      };
      assert.ok(reach.has(c.z * MAP_W + c.x), `${zone.id} is unreachable with all doors open`);
    }
    for (const w of WALL_BUYS) {
      assert.ok(reach.has(w.tz * MAP_W + w.tx), `${w.weapon} wall buy is unreachable`);
    }
    for (const p of PERKS) {
      assert.ok(reach.has(p.tz * MAP_W + p.tx), `${p.perk} machine is unreachable`);
    }
  });

  it('round-trips world and tile coordinates', () => {
    const c = tileCenter(12, 7);
    const t = worldToTile(c.x, c.z);
    assert.deepEqual(t, { tx: 12, tz: 7 });
    assert.equal(c.x, 12.5 * TILE);
  });
});

describe('collision and pathing', () => {
  const grid = new NavGrid(buildTileMap());

  it('pushes a body out of a wall instead of letting it through', () => {
    // Just inside the lobby's west wall (tile 17 is solid at z=34, tile 18 is floor).
    const wallFace = 18 * TILE;
    const r = 0.55;
    const res = grid.resolveCircle(wallFace - 0.2, 34.5 * TILE, r);
    assert.ok(res.hitWall, 'expected a wall contact');
    assert.ok(res.x >= wallFace - 1e-6, `body ended inside the wall at x=${res.x}`);
  });

  it('leaves a body in open space untouched', () => {
    const c = tileCenter(24, 31);
    const res = grid.resolveCircle(c.x, c.z, 0.55);
    assert.equal(res.hitWall, false);
    assert.ok(Math.abs(res.x - c.x) < 1e-9 && Math.abs(res.z - c.z) < 1e-9);
  });

  it('stops a raycast at the first solid tile', () => {
    const from = tileCenter(24, 34);
    const hit = grid.raycast(from.x, from.z, -1, 0, 200);
    assert.ok(hit.hit, 'ray should have hit the west wall');
    // Wall face of tile 17 on its +x side.
    assert.equal(hit.tx, 17);
    assert.ok(Math.abs(hit.x - 18 * TILE) < 0.001, `hit at x=${hit.x}`);
    assert.equal(hit.nx, 1);
  });

  it('reports line of sight honestly', () => {
    const a = tileCenter(20, 27);
    const b = tileCenter(27, 34);
    assert.equal(grid.lineOfSight(a.x, a.z, b.x, b.z), true);
    const outside = tileCenter(7, 32); // furnace hall, behind a locked door
    assert.equal(grid.lineOfSight(a.x, a.z, outside.x, outside.z), false);
  });

  it('builds a flow field that descends to the goal', () => {
    const torn = new Set<number>();
    assert.equal(grid.buildFlowField(24, 31, torn), true);

    let tx = 20;
    let tz = 27;
    let steps = 0;
    while (!(tx === 24 && tz === 31)) {
      const f = grid.flowAt(tx, tz);
      if (!f) throw new Error(`no flow at ${tx},${tz}`);
      const before = grid.distanceAt(tx, tz);
      tx += f.dx;
      tz += f.dz;
      assert.equal(grid.distanceAt(tx, tz), before - 1, 'flow must strictly descend');
      assert.ok(++steps < 500, 'flow field looped');
    }
    assert.ok(steps > 0);
  });

  it('will not path through an intact barricade but will through a torn one', () => {
    const b = BARRICADES[0];
    const torn = new Set<number>();
    assert.equal(grid.solidForZombie(b.tx, b.tz, torn), true);
    torn.add(grid.idx(b.tx, b.tz));
    assert.equal(grid.solidForZombie(b.tx, b.tz, torn), false);
  });

  it('refuses to build a field on a solid goal', () => {
    assert.equal(new NavGrid(buildTileMap()).buildFlowField(0, 0, new Set()), false);
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
      assert.ok(w.parts.length > 0, `${w.id} has no view model`);
      assert.ok(w.rpm > 0 && w.magSize > 0, `${w.id} has bad fire data`);
      assert.ok(w.range > 0);
      assert.ok(w.reserveMax >= w.magSize, `${w.id} reserve smaller than a magazine`);
      for (const p of w.parts) {
        assert.equal(p.size.length, 3);
        assert.equal(p.pos.length, 3);
        assert.ok(p.size.every((v) => v > 0), `${w.id} has a zero-size part`);
      }
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
