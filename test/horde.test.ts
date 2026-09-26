/**
 * The horde: how it paths round the furniture, how it splits itself up, what a
 * tank is, and - the one that was actually broken - where a body can be shot.
 *
 * The hit-box tests pose a body by hand and work out where three.js will draw it
 * from the same root transform the animation sets, then fire at that. That is
 * the invariant that matters: what you can see and what you can shoot have to be
 * the same thing.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as THREE from 'three';

import { MAP_H, MAP_W, TILE, T_FLOOR, T_VOID, tileCenter } from '../src/world/mapdata.ts';
import { NavGrid } from '../src/world/grid.ts';
import { Rng } from '../src/core/rng.ts';
import { Enemy, rayHitsEnemy } from '../src/game/enemy.ts';
import { COMMIT_RANGE, Horde, manoeuvres } from '../src/game/horde.ts';
import type { ZombieModel } from '../src/gfx/models.ts';
import {
  ENEMY_INFO,
  MAX_THREAT,
  enemyDamage,
  enemySpeed,
  hordeCunning,
  roundMix,
  scoreForKill,
  type EnemyKind,
} from '../src/game/rules.ts';

/** A hand-made arena: one open rectangle of floor in an otherwise solid map. */
function openRoom(x0: number, z0: number, w: number, h: number): NavGrid {
  const tiles = new Uint8Array(MAP_W * MAP_H).fill(T_VOID);
  for (let tz = z0; tz < z0 + h; tz++) {
    for (let tx = x0; tx < x0 + w; tx++) tiles[tz * MAP_W + tx] = T_FLOOR;
  }
  return new NavGrid(tiles);
}

/** Fills one tile edge to edge with something solid. */
function crate(grid: NavGrid, tx: number, tz: number): void {
  const c = tileCenter(tx, tz);
  grid.addObstacle(c.x, c.z, TILE / 2, TILE / 2);
}

describe('pathing round the furniture', () => {
  it('reads a tile packed with furniture as near solid, and its neighbours as clear', () => {
    const grid = openRoom(10, 20, 20, 5);
    assert.equal(grid.fillAt(20, 22), 0);
    crate(grid, 20, 22);
    assert.equal(grid.fillAt(20, 22), 2);
    assert.equal(grid.fillAt(20, 21), 0);
    assert.equal(grid.fillAt(19, 22), 0);
  });

  it('lets you see over a crate but not walk through it', () => {
    const grid = openRoom(10, 20, 20, 5);
    crate(grid, 20, 22);
    const a = tileCenter(14, 22);
    const b = tileCenter(26, 22);
    assert.equal(grid.lineOfSight(a.x, a.z, b.x, b.z), true, 'a crate is not a wall');
    assert.equal(grid.clearWalk(a.x, a.z, b.x, b.z), false, 'but you cannot walk through one');
    const from = tileCenter(14, 21);
    const to = tileCenter(26, 21);
    assert.equal(grid.clearWalk(from.x, from.z, to.x, to.z), true, 'the clear row is still clear');
  });

  it('routes the horde round a crate instead of into the side of it', () => {
    const grid = openRoom(10, 20, 20, 5);
    crate(grid, 20, 22);
    assert.equal(grid.buildFlowField(10, 22, new Set()), true);
    let tx = 29;
    let tz = 22;
    const walked: number[] = [];
    for (let guard = 0; guard < 200 && !(tx === 10 && tz === 22); guard++) {
      const f = grid.flowAt(tx, tz);
      if (!f) throw new Error('no flow at ' + tx + ',' + tz);
      tx += f.dx;
      tz += f.dz;
      walked.push(grid.idx(tx, tz));
    }
    assert.equal(tx, 10, 'never reached the goal');
    assert.ok(!walked.includes(grid.idx(20, 22)), 'walked straight through the crate');
  });

  it('never lets a crate seal a corridor off, however tight', () => {
    // One tile wide with the crate filling it: the only way past is through.
    const grid = openRoom(10, 22, 20, 1);
    crate(grid, 20, 22);
    assert.equal(grid.buildFlowField(10, 22, new Set()), true);
    assert.ok(grid.distanceAt(29, 22) > 0, 'the far end went unreachable');
    // And it costs more to cross than the same walk over clear floor.
    const clear = openRoom(10, 22, 20, 1);
    assert.equal(clear.buildFlowField(10, 22, new Set()), true);
    assert.ok(grid.distanceAt(29, 22) > clear.distanceAt(29, 22), 'the crate cost nothing');
  });

  it('keeps a field per slot, each with its own goal', () => {
    const grid = openRoom(10, 20, 20, 5);
    const torn = new Set<number>();
    assert.equal(grid.buildFlowField(10, 22, torn, 0), true);
    assert.equal(grid.buildFlowField(29, 22, torn, 1), true);
    // Standing in the middle, the two fields send a body opposite ways.
    const a = grid.flowAt(20, 22, 0);
    const b = grid.flowAt(20, 22, 1);
    assert.ok(a && b);
    assert.equal(a.dx, -1);
    assert.equal(b.dx, 1);
    // And neither rebuild disturbed the other.
    assert.ok(grid.distanceAt(11, 22, 0) < grid.distanceAt(11, 22, 1));
  });

  it('still descends strictly with furniture on the floor', () => {
    const grid = openRoom(10, 20, 20, 5);
    crate(grid, 20, 22);
    crate(grid, 15, 21);
    assert.equal(grid.buildFlowField(10, 20, new Set()), true);
    for (let tz = 20; tz < 25; tz++) {
      for (let tx = 10; tx < 30; tx++) {
        if (tx === 10 && tz === 20) continue;
        const f = grid.flowAt(tx, tz);
        assert.ok(f, 'no flow at ' + tx + ',' + tz);
        assert.ok(
          grid.distanceAt(tx + f.dx, tz + f.dz) < grid.distanceAt(tx, tz),
          'flow does not descend at ' + tx + ',' + tz,
        );
      }
    }
  });

  it('nudges a goal inside a wall out to somewhere a body could stand', () => {
    const grid = openRoom(10, 20, 20, 5);
    const open = grid.nearestOpen(8, 22, new Set());
    assert.ok(open, 'gave up on a goal two tiles from the floor');
    assert.equal(grid.solidForZombie(open.tx, open.tz, new Set()), false);
    assert.equal(grid.nearestOpen(60, 60, new Set()), null, 'invented floor in the void');
  });

  it('prefers a clear tile to a full one when nudging a goal', () => {
    const grid = openRoom(10, 20, 20, 5);
    crate(grid, 10, 20);
    const open = grid.nearestOpen(9, 20, new Set());
    assert.ok(open);
    assert.ok(grid.fillAt(open.tx, open.tz) < 2, 'parked the goal inside the furniture');
  });
});

describe('how coordinated the crowd is', () => {
  it('works up to full cunning over the early rounds, and sooner under threat', () => {
    assert.equal(hordeCunning(1), 0, 'round one is the straight line it always was');
    assert.equal(hordeCunning(2), 0);
    assert.ok(hordeCunning(5) > 0 && hordeCunning(5) < 1);
    assert.equal(hordeCunning(10), 1);
    for (let r = 1; r < 30; r++) {
      assert.ok(hordeCunning(r + 1) >= hordeCunning(r), 'dipped at round ' + r);
    }
    for (let t = 1; t <= MAX_THREAT; t++) {
      assert.ok(hordeCunning(5, t) > hordeCunning(5), 'threat ' + t + ' is no keener');
      assert.ok(hordeCunning(40, t) <= 1, 'cunning ran off the top');
    }
  });

  it('leaves the heavy kinds out of the manoeuvring', () => {
    assert.equal(manoeuvres('tank'), false);
    assert.equal(manoeuvres('brute'), false);
    assert.equal(manoeuvres('crawler'), false);
    assert.equal(manoeuvres('armoured'), false);
    assert.equal(manoeuvres('walker'), true);
    assert.equal(manoeuvres('runner'), true);
    assert.equal(manoeuvres('hound'), true);
  });
});

describe('dealing out the roles', () => {
  /** Drives a real coordinator over a crowd standing well out of charging range. */
  function deal(kinds: EnemyKind[], cunning: number): Enemy[] {
    const grid = openRoom(10, 20, 30, 12);
    const horde = new Horde();
    const at = tileCenter(20, 25);
    const crowd = kinds.map((kind, i) => {
      const e = posed(kind, 0);
      // A ring of bodies two tiles out from the player, all further off than
      // COMMIT_RANGE so none of them is already in the fight.
      const a = (i / kinds.length) * Math.PI * 2;
      e.x = at.x + Math.cos(a) * (COMMIT_RANGE + 6);
      e.z = at.z + Math.sin(a) * (COMMIT_RANGE + 6);
      return e;
    });
    horde.update(0.5, grid, new Set(), { x: at.x, z: at.z, fx: 0, fz: 1 }, crowd, cunning);
    return crowd;
  }

  it('sends nobody anywhere in the first rounds', () => {
    const crowd = deal(['walker', 'runner', 'walker', 'runner', 'walker', 'hound'], 0);
    for (const e of crowd) assert.equal(e.role, 'chase', 'manoeuvring at zero cunning');
  });

  it('splits the crowd up once it knows how', () => {
    const kinds: EnemyKind[] = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'runner' : 'walker'));
    const crowd = deal(kinds, 1);
    const roles = new Set(crowd.map((e) => e.role));
    assert.ok(roles.has('chase'), 'nobody left coming straight at you');
    assert.ok(roles.size > 1, 'the whole crowd was given the same job');
    assert.ok(roles.has('left') || roles.has('right'), 'nobody sent round the side');
    // Half the crowd still comes at you: a horde that is all manoeuvre is a
    // horde standing about.
    const chasing = crowd.filter((e) => e.role === 'chase').length;
    assert.ok(chasing >= crowd.length / 2, 'only ' + chasing + ' of ' + crowd.length + ' still chasing');
  });

  it('never sends a lone body off on a manoeuvre', () => {
    for (const e of deal(['runner'], 1)) assert.equal(e.role, 'chase');
    // And at any size, at least half of them are still coming straight at you.
    for (let n = 1; n <= 20; n++) {
      const kinds: EnemyKind[] = Array.from({ length: n }, () => 'runner');
      const crowd = deal(kinds, 1);
      const chasing = crowd.filter((e) => e.role === 'chase').length;
      assert.ok(chasing >= n / 2, n + ' bodies left only ' + chasing + ' chasing');
    }
  });

  it('leaves the heavy kinds coming straight at you, budget or no budget', () => {
    const heavy: EnemyKind[] = ['tank', 'brute', 'crawler', 'armoured'];
    const crowd = deal([...heavy, ...heavy, 'runner', 'walker'], 1);
    for (const e of crowd) {
      if (manoeuvres(e.kind)) continue;
      assert.equal(e.role, 'chase', e.kind + ' was sent out wide');
    }
  });

  it('keeps a body on the job it already has', () => {
    const kinds: EnemyKind[] = Array.from({ length: 10 }, () => 'runner');
    const grid = openRoom(10, 20, 30, 12);
    const horde = new Horde();
    const at = tileCenter(20, 25);
    const crowd = kinds.map((kind, i) => {
      const e = posed(kind, 0);
      const a = (i / kinds.length) * Math.PI * 2;
      e.x = at.x + Math.cos(a) * (COMMIT_RANGE + 6);
      e.z = at.z + Math.sin(a) * (COMMIT_RANGE + 6);
      return e;
    });
    const target = { x: at.x, z: at.z, fx: 0, fz: 1 };
    horde.update(0.5, grid, new Set(), target, crowd, 1);
    const first = crowd.map((e) => e.role);
    for (let i = 0; i < 6; i++) horde.update(0.5, grid, new Set(), target, crowd, 1);
    assert.deepEqual(crowd.map((e) => e.role), first, 'roles churned between deals');
  });
});

describe('tanks', () => {
  const KINDS = Object.keys(ENEMY_INFO) as EnemyKind[];

  it('is the biggest, toughest, slowest thing in the crowd', () => {
    const tank = ENEMY_INFO.tank;
    for (const kind of KINDS) {
      if (kind === 'tank') continue;
      assert.ok(tank.scale > ENEMY_INFO[kind].scale, 'no bigger than a ' + kind);
      assert.ok(tank.health > ENEMY_INFO[kind].health, 'no tougher than a ' + kind);
      assert.ok(enemySpeed(12, 'tank') < enemySpeed(12, kind), 'no slower than a ' + kind);
      assert.ok(enemyDamage('tank') > enemyDamage(kind), 'hits no harder than a ' + kind);
    }
  });

  it('pays four ordinary kills', () => {
    const walker = scoreForKill('body', false, ENEMY_INFO.walker.score);
    const tank = scoreForKill('body', false, ENEMY_INFO.tank.score);
    assert.equal(tank, walker * 4);
    // A headshot on one still beats a body shot, and double points still doubles.
    assert.ok(scoreForKill('head', false, 4) > tank);
    assert.equal(scoreForKill('body', true, 4), tank * 2);
    // And nothing else got quietly repriced.
    for (const kind of KINDS) {
      if (kind === 'tank') continue;
      assert.equal(ENEMY_INFO[kind].score, 1, kind + ' is no longer worth one kill');
    }
  });

  it('turns up late and stays rare', () => {
    const weight = (r: number, t = 0): number =>
      roundMix(r, t).find((m) => m.kind === 'tank')?.weight ?? 0;
    assert.equal(weight(9), 0, 'a tank before round ten');
    assert.ok(weight(12) > 0, 'no tanks by round twelve');
    for (let r = 1; r <= 60; r++) assert.ok(weight(r) <= 0.06, 'too many tanks at round ' + r);
    // Threat brings them forward like everything else.
    assert.ok(weight(9, MAX_THREAT) > 0);
  });

  it('has a pooled body for every kind of enemy there is', () => {
    for (const kind of KINDS) {
      const build = ENEMY_INFO[kind].build;
      assert.ok(['humanoid', 'hound', 'tank'].includes(build), kind + ' has no body');
    }
    assert.equal(ENEMY_INFO.tank.build, 'tank');
    assert.equal(ENEMY_INFO.hound.build, 'hound');
  });
});

/** A body with no geometry: enough of a model for the maths and nothing else. */
function stubZombie(height: number, headHeight: number, radius: number): ZombieModel {
  const group = (): THREE.Group => new THREE.Group();
  return {
    root: group(), body: group(), head: group(), jaw: new THREE.Mesh(),
    armL: group(), armR: group(), legL: group(), legR: group(),
    parts: [], lit: [], headHeight, height, radius,
  };
}

/** How tall and wide the pooled humanoid body is, before its kind resizes it. */
const MODEL_HEIGHT = 3.45;
const MODEL_HEAD = 3.05;
const MODEL_RADIUS = 0.62;

/** One body, posed by hand: the spawn roll has no business in a hit test. */
function posed(kind: EnemyKind, yaw: number): Enemy {
  const e = new Enemy(stubZombie(MODEL_HEIGHT, MODEL_HEAD, MODEL_RADIUS));
  e.spawn(kind, 40, 60, 1000, 5, null, new Rng(7));
  e.sizeScale = ENEMY_INFO[kind].scale;
  e.lean = ENEMY_INFO[kind].lean;
  e.radius = MODEL_RADIUS * (e.lean > 0.5 ? 0.85 : e.sizeScale);
  e.yaw = yaw;
  e.y = 0;
  return e;
}

/**
 * Where three.js will actually draw a point up the body, from the same root
 * transform `animate` sets. Worked out without going near the enemy's own head
 * getters, which is the point: what is drawn and what is shot must agree.
 */
function drawnAt(e: Enemy, up: number): THREE.Vector3 {
  const o = new THREE.Object3D();
  o.rotation.order = 'YXZ';
  o.rotation.set(e.lean, e.yaw, 0);
  o.position.set(e.drawX, e.y, e.drawZ);
  o.updateMatrix();
  return new THREE.Vector3(0, up, 0).applyMatrix4(o.matrix);
}

/** Fires at a point from a few metres away on the -z side of it. */
function shootAt(e: Enemy, at: THREE.Vector3, back = 14): { dist: number; head: boolean } | null {
  const from = new THREE.Vector3(at.x, 3, at.z - back);
  const dir = at.clone().sub(from).normalize();
  return rayHitsEnemy(from.x, from.y, from.z, dir.x, dir.y, dir.z, e, 60);
}

describe('hit boxes', () => {
  it('draws an upright body exactly where it stands', () => {
    const e = posed('walker', 1.1);
    assert.ok(Math.abs(e.drawX - e.x) < 1e-9);
    assert.ok(Math.abs(e.drawZ - e.z) < 1e-9);
    assert.ok(Math.abs(e.bodyTop - (e.y + MODEL_HEIGHT * e.sizeScale)) < 1e-9);
  });

  it('tells a headshot from a body shot on an upright body', () => {
    const e = posed('walker', 0);
    const head = shootAt(e, drawnAt(e, MODEL_HEAD * e.sizeScale));
    assert.ok(head, 'missed the head entirely');
    assert.equal(head.head, true);
    const chest = shootAt(e, drawnAt(e, 1.9 * e.sizeScale));
    assert.ok(chest, 'missed the chest entirely');
    assert.equal(chest.head, false);
    // And a shot a body width to the side goes past.
    const wide = drawnAt(e, 2);
    wide.x += 3;
    assert.equal(shootAt(e, wide), null);
  });

  it('keeps a crawler head out in front of its feet, where it is drawn', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2.4, -1.9]) {
      const e = posed('crawler', yaw);
      const drawn = drawnAt(e, MODEL_HEAD * e.sizeScale);
      assert.ok(Math.abs(e.headX - drawn.x) < 1e-6, 'headX off at yaw ' + yaw);
      assert.ok(Math.abs(e.headY - drawn.y) < 1e-6, 'headY off at yaw ' + yaw);
      assert.ok(Math.abs(e.headZ - drawn.z) < 1e-6, 'headZ off at yaw ' + yaw);
      // Dragging along the floor, so about half a metre up - two world units to
      // the metre - and the body straddles the point it navigates by.
      assert.ok(e.headY > 0.9 && e.headY < 1.6, 'head at ' + e.headY + ' at yaw ' + yaw);
      const out = Math.hypot(e.headX - e.x, e.headZ - e.z);
      assert.ok(out > 1, 'head only ' + out + ' in front of its feet at yaw ' + yaw);
      // Which is why a vertical cylinder at its feet could not be shot in the
      // head: on a crawler the head is not above the feet at all.
      assert.ok(out > e.hitRadius, 'the head is inside the old hit box after all');
    }
  });

  it('scores a headshot on a crawler where its head is drawn', () => {
    for (const yaw of [0, 1.3, -2.2]) {
      const e = posed('crawler', yaw);
      const hit = shootAt(e, drawnAt(e, MODEL_HEAD * e.sizeScale));
      assert.ok(hit, 'missed a crawler head at yaw ' + yaw);
      assert.equal(hit.head, true, 'not a headshot at yaw ' + yaw);
      // Its hips are the same body, and they are not a headshot.
      const hips = shootAt(e, drawnAt(e, 1.5 * e.sizeScale));
      assert.ok(hips, 'missed a crawler hips at yaw ' + yaw);
      assert.equal(hips.head, false, 'hips read as a headshot at yaw ' + yaw);
    }
  });

  it('misses the empty air a crawler used to be shot in', () => {
    const e = posed('crawler', 0);
    // Straight up from the nav point, at the height the head *would* be if it
    // were standing. Nothing is there, and nothing there used to be a headshot.
    assert.equal(shootAt(e, new THREE.Vector3(e.x, 3.0, e.z)), null, 'still hitting thin air');
  });

  it('is only a body wide across the spine', () => {
    // From the side this time, square on to a body lying along +z: the head is
    // there to be hit and the floor a body width to either side of it is not.
    const e = posed('crawler', 0);
    const head = drawnAt(e, MODEL_HEAD * e.sizeScale);
    const from = new THREE.Vector3(head.x - 14, 3, head.z);
    const shot = (at: THREE.Vector3): { dist: number; head: boolean } | null => {
      const dir = at.clone().sub(from).normalize();
      return rayHitsEnemy(from.x, from.y, from.z, dir.x, dir.y, dir.z, e, 60);
    };
    const onHead = shot(head);
    assert.ok(onHead, 'missed a crawler head from the side');
    assert.equal(onHead.head, true, 'not a headshot from the side');
    for (const off of [2.5, -2.5]) {
      const past = head.clone();
      past.z += off;
      assert.equal(shot(past), null, 'hit the floor ' + off + ' from the spine');
    }
  });

  it('gives a tank a taller body and more weight than a shambler', () => {
    const tank = posed('tank', 0);
    const walker = posed('walker', 0);
    assert.ok(tank.spine > walker.spine * 1.3, 'a tank is not much taller');
    assert.ok(tank.hitRadius > walker.hitRadius, 'a tank is no broader');
    assert.ok(tank.mass > walker.mass * 2, 'a tank weighs no more');
    // Head height on a tank is over a shambler's head entirely.
    assert.ok(tank.headFrom > MODEL_HEIGHT * walker.sizeScale * 0.8);
    // And it is hittable in the head up there, where a shambler is not.
    const up = drawnAt(tank, MODEL_HEAD * tank.sizeScale);
    const hit = shootAt(tank, up);
    assert.ok(hit, 'missed a tank head');
    assert.equal(hit.head, true);
  });

  it('shoves the lighter body when two of them overlap', () => {
    const tank = posed('tank', 0);
    const walker = posed('walker', 0);
    walker.x = tank.x + 0.4;
    const tankFrom = tank.x;
    const walkerFrom = walker.x;
    tank.separate(walker, 1);
    const tankMoved = Math.abs(tank.x - tankFrom);
    const walkerMoved = Math.abs(walker.x - walkerFrom);
    assert.ok(walkerMoved > tankMoved * 1.5, 'the tank gave as much ground as the shambler');
    // Two of a size still share it down the middle, as they always did.
    const a = posed('walker', 0);
    const b = posed('walker', 0);
    b.x = a.x + 0.4;
    const aFrom = a.x;
    const bFrom = b.x;
    a.separate(b, 1);
    assert.ok(Math.abs(Math.abs(a.x - aFrom) - Math.abs(b.x - bFrom)) < 1e-9);
  });
});
