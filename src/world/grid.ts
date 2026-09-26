/**
 * Collision + navigation over the tile grid.
 *
 * Zombie pathing uses a breadth-first flow field rebuilt from the player's tile
 * a few times a second. With a 48x40 grid that is ~1900 cells, so a full rebuild
 * is cheaper than running A* per zombie and it gives a whole horde perfect,
 * identical routing - which is exactly the arcade behaviour we want.
 *
 * On top of the tiles sits an obstacle layer: axis-aligned boxes on the floor
 * for everything solid that is smaller than a tile - perk machines, the
 * Pack-a-Punch, the mystery box, trap pylons, and the chunky half of the set
 * dressing. Bodies are pushed out of those the same way they are pushed out of
 * walls, so neither the player nor the horde walks through the furniture any
 * more. Static ones are bucketed by tile, so a lookup only ever visits the few
 * boxes that touch the tiles the body overlaps; the handful that move (the
 * mystery boxes) live in a short list that is scanned in full.
 *
 * The flow field deliberately ignores obstacles. They are all far smaller than
 * the rooms they stand in, the push-out slides a body along them, and the
 * enemy's own stuck detection shoulders it sideways - which is much cheaper
 * than a sub-tile navigation mesh and, in an arcade arena, reads the same.
 */

import {
  MAP_H,
  MAP_W,
  TILE,
  T_BARRICADE,
  T_DOOR,
  T_FLOOR,
  T_VOID,
  T_WALL,
} from './mapdata.ts';

export type Hit = {
  hit: boolean;
  dist: number;
  x: number;
  z: number;
  /** Face normal of the tile that was struck. */
  nx: number;
  nz: number;
  tx: number;
  tz: number;
};

/** A solid box on the floor, in world units. Half-extents, axis aligned. */
export type Obstacle = {
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** A box that is switched off is ignored: a mystery box in flight, say. */
  active: boolean;
};

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class NavGrid {
  readonly base: Uint8Array;
  /** Live tile state: doors flip to floor when bought, barricades when torn. */
  readonly tiles: Uint8Array;

  private readonly dist: Int32Array;
  private readonly flowX: Int8Array;
  private readonly flowZ: Int8Array;
  private readonly queue: Int32Array;
  private fieldOrigin = -1;

  /** Solid boxes that never move, bucketed by the tiles they touch. */
  private readonly obstacles: Obstacle[] = [];
  private readonly buckets = new Map<number, number[]>();
  /** Which resolve pass last looked at each static obstacle, so none is pushed twice. */
  private readonly seen: number[] = [];
  private pass = 0;
  /** Solid boxes that move. Short enough to scan in full every resolve. */
  readonly movers: Obstacle[] = [];

  constructor(base: Uint8Array) {
    this.base = base;
    this.tiles = Uint8Array.from(base);
    this.dist = new Int32Array(MAP_W * MAP_H);
    this.flowX = new Int8Array(MAP_W * MAP_H);
    this.flowZ = new Int8Array(MAP_W * MAP_H);
    this.queue = new Int32Array(MAP_W * MAP_H);
  }

  idx(tx: number, tz: number): number {
    return tz * MAP_W + tx;
  }

  inBounds(tx: number, tz: number): boolean {
    return tx >= 0 && tz >= 0 && tx < MAP_W && tz < MAP_H;
  }

  get(tx: number, tz: number): number {
    if (!this.inBounds(tx, tz)) return T_VOID;
    return this.tiles[tz * MAP_W + tx];
  }

  set(tx: number, tz: number, value: number): void {
    if (!this.inBounds(tx, tz)) return;
    this.tiles[tz * MAP_W + tx] = value;
    this.fieldOrigin = -1; // topology changed, force a flow-field rebuild
  }

  /* ------------------------------------------------------------ obstacles */

  /**
   * Adds a solid box on the floor. `hx`/`hz` are half-extents in world units;
   * rotated furniture is registered as the box that contains it.
   */
  addObstacle(x: number, z: number, hx: number, hz: number): Obstacle {
    const o: Obstacle = { x, z, hx, hz, active: true };
    const i = this.obstacles.length;
    this.obstacles.push(o);
    this.seen.push(-1);
    const tx0 = Math.floor((x - hx) / TILE);
    const tx1 = Math.floor((x + hx) / TILE);
    const tz0 = Math.floor((z - hz) / TILE);
    const tz1 = Math.floor((z + hz) / TILE);
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.inBounds(tx, tz)) continue;
        const key = this.idx(tx, tz);
        const list = this.buckets.get(key);
        if (list) list.push(i);
        else this.buckets.set(key, [i]);
      }
    }
    return o;
  }

  /** A moving solid: the caller keeps the handle and edits it in place. */
  addMover(x: number, z: number, hx: number, hz: number): Obstacle {
    const o: Obstacle = { x, z, hx, hz, active: true };
    this.movers.push(o);
    return o;
  }

  clearObstacles(): void {
    this.obstacles.length = 0;
    this.seen.length = 0;
    this.movers.length = 0;
    this.buckets.clear();
  }

  get obstacleCount(): number {
    return this.obstacles.length;
  }

  /** True when a body of this radius standing here would be inside something solid. */
  blocked(x: number, z: number, r: number): boolean {
    const minTx = Math.floor((x - r) / TILE);
    const maxTx = Math.floor((x + r) / TILE);
    const minTz = Math.floor((z - r) / TILE);
    const maxTz = Math.floor((z + r) / TILE);
    for (let tz = minTz; tz <= maxTz; tz++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (this.solid(tx, tz) && boxOverlapsCircle(tx * TILE, tz * TILE, TILE, TILE, x, z, r)) return true;
        const list = this.buckets.get(this.idx(tx, tz));
        if (!list) continue;
        for (const i of list) {
          const o = this.obstacles[i];
          if (o.active && boxOverlapsCircle(o.x - o.hx, o.z - o.hz, o.hx * 2, o.hz * 2, x, z, r)) return true;
        }
      }
    }
    for (const o of this.movers) {
      if (o.active && boxOverlapsCircle(o.x - o.hx, o.z - o.hz, o.hx * 2, o.hz * 2, x, z, r)) return true;
    }
    return false;
  }

  /** Walls block everything. Barricades block the player but not zombies once torn. */
  solid(tx: number, tz: number): boolean {
    const t = this.get(tx, tz);
    return t === T_VOID || t === T_WALL || t === T_DOOR || t === T_BARRICADE;
  }

  /** Zombies may walk over a torn-open barricade tile; a whole one still blocks. */
  solidForZombie(tx: number, tz: number, tornBarricades: Set<number>): boolean {
    const t = this.get(tx, tz);
    if (t === T_FLOOR) return false;
    if (t === T_BARRICADE) return !tornBarricades.has(this.idx(tx, tz));
    return true;
  }

  /**
   * Pushes a circle out of any solid tile or obstacle it overlaps. Axis-
   * separated so the body slides along walls instead of sticking - the classic
   * arcade feel. Obstacles go first in each pass and tiles second, so whatever
   * a crate shoves the body into, a wall still gets the last word.
   */
  resolveCircle(
    x: number,
    z: number,
    r: number,
    passable?: Set<number>,
  ): { x: number; z: number; hitWall: boolean } {
    let px = x;
    let pz = z;
    let hitWall = false;
    const r2 = r * r;

    /** Shortest push that takes the circle out of a box, or nothing. */
    const eject = (left: number, top: number, w: number, h: number): boolean => {
      const cx = Math.max(left, Math.min(px, left + w));
      const cz = Math.max(top, Math.min(pz, top + h));
      let dx = px - cx;
      let dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) return false;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        px += (dx / d) * (r - d);
        pz += (dz / d) * (r - d);
      } else {
        // Dead inside: eject along the shallowest axis.
        dx = px - (left + w / 2);
        dz = pz - (top + h / 2);
        if (Math.abs(dx) / w > Math.abs(dz) / h) px += dx > 0 ? w / 2 + r : -(w / 2 + r);
        else pz += dz > 0 ? h / 2 + r : -(h / 2 + r);
      }
      return true;
    };

    for (let pass = 0; pass < 2; pass++) {
      this.pass++;
      const minTx = Math.floor((px - r) / TILE);
      const maxTx = Math.floor((px + r) / TILE);
      const minTz = Math.floor((pz - r) / TILE);
      const maxTz = Math.floor((pz + r) / TILE);

      if (this.buckets.size) {
        for (let tz = minTz; tz <= maxTz; tz++) {
          for (let tx = minTx; tx <= maxTx; tx++) {
            const list = this.buckets.get(this.idx(tx, tz));
            if (!list) continue;
            for (const i of list) {
              if (this.seen[i] === this.pass) continue;
              this.seen[i] = this.pass;
              const o = this.obstacles[i];
              if (o.active) eject(o.x - o.hx, o.z - o.hz, o.hx * 2, o.hz * 2);
            }
          }
        }
      }
      for (const o of this.movers) {
        if (o.active) eject(o.x - o.hx, o.z - o.hz, o.hx * 2, o.hz * 2);
      }

      for (let tz = minTz; tz <= maxTz; tz++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (passable && passable.has(this.idx(tx, tz))) continue;
          if (!this.solid(tx, tz)) continue;
          if (eject(tx * TILE, tz * TILE, TILE, TILE)) hitWall = true;
        }
      }
    }

    return { x: px, z: pz, hitWall };
  }

  /**
   * DDA raycast against solid tiles. Used for bullets, line of sight and for
   * keeping the camera honest about what the player can actually see.
   */
  raycast(
    x0: number,
    z0: number,
    dx: number,
    dz: number,
    maxDist: number,
    passable?: Set<number>,
  ): Hit {
    const miss: Hit = {
      hit: false,
      dist: maxDist,
      x: x0 + dx * maxDist,
      z: z0 + dz * maxDist,
      nx: 0,
      nz: 0,
      tx: -1,
      tz: -1,
    };

    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return miss;
    const rx = dx / len;
    const rz = dz / len;

    let tx = Math.floor(x0 / TILE);
    let tz = Math.floor(z0 / TILE);
    const stepX = rx > 0 ? 1 : -1;
    const stepZ = rz > 0 ? 1 : -1;
    const invX = rx !== 0 ? Math.abs(TILE / rx) : Infinity;
    const invZ = rz !== 0 ? Math.abs(TILE / rz) : Infinity;

    let sideX =
      rx !== 0
        ? (rx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(rx)
        : Infinity;
    let sideZ =
      rz !== 0
        ? (rz > 0 ? (tz + 1) * TILE - z0 : z0 - tz * TILE) / Math.abs(rz)
        : Infinity;

    let travelled = 0;
    let nx = 0;
    let nz = 0;

    for (let guard = 0; guard < 512; guard++) {
      if (sideX < sideZ) {
        travelled = sideX;
        sideX += invX;
        tx += stepX;
        nx = -stepX;
        nz = 0;
      } else {
        travelled = sideZ;
        sideZ += invZ;
        tz += stepZ;
        nx = 0;
        nz = -stepZ;
      }
      if (travelled > maxDist) return miss;

      const skip = passable?.has(this.idx(tx, tz)) ?? false;
      if (!skip && this.solid(tx, tz)) {
        return {
          hit: true,
          dist: travelled,
          x: x0 + rx * travelled,
          z: z0 + rz * travelled,
          nx,
          nz,
          tx,
          tz,
        };
      }
    }
    return miss;
  }

  /** True when nothing solid sits between the two world-space points. */
  lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return true;
    const hit = this.raycast(x0, z0, dx / d, dz / d, d - 0.05);
    return !hit.hit;
  }

  /**
   * Rebuilds the BFS flow field toward a goal tile. Returns false when the goal
   * is not walkable, in which case the previous field is left intact.
   */
  buildFlowField(goalTx: number, goalTz: number, tornBarricades: Set<number>): boolean {
    if (!this.inBounds(goalTx, goalTz)) return false;
    if (this.solidForZombie(goalTx, goalTz, tornBarricades)) return false;

    const goal = this.idx(goalTx, goalTz);
    if (goal === this.fieldOrigin) return true;

    this.dist.fill(-1);
    this.flowX.fill(0);
    this.flowZ.fill(0);

    const q = this.queue;
    let head = 0;
    let tail = 0;
    q[tail++] = goal;
    this.dist[goal] = 0;

    while (head < tail) {
      const cur = q[head++];
      const cx = cur % MAP_W;
      const cz = (cur / MAP_W) | 0;
      const nd = this.dist[cur] + 1;

      for (const [dx, dz] of NEIGHBOURS) {
        const nxt = cx + dx;
        const nzt = cz + dz;
        if (!this.inBounds(nxt, nzt)) continue;
        const ni = nzt * MAP_W + nxt;
        if (this.dist[ni] !== -1) continue;
        if (this.solidForZombie(nxt, nzt, tornBarricades)) continue;
        this.dist[ni] = nd;
        // Point back the way we came: that is the direction of travel.
        this.flowX[ni] = -dx;
        this.flowZ[ni] = -dz;
        q[tail++] = ni;
      }
    }

    this.fieldOrigin = goal;
    return true;
  }

  /** Forces the next buildFlowField call to recompute even for the same goal. */
  invalidateField(): void {
    this.fieldOrigin = -1;
  }

  /** Step direction toward the goal from a tile, or null if unreachable. */
  flowAt(tx: number, tz: number): { dx: number; dz: number; dist: number } | null {
    if (!this.inBounds(tx, tz)) return null;
    const i = tz * MAP_W + tx;
    if (this.dist[i] < 0) return null;
    return { dx: this.flowX[i], dz: this.flowZ[i], dist: this.dist[i] };
  }

  /** Tile distance to the flow-field goal, or -1 when unreachable. */
  distanceAt(tx: number, tz: number): number {
    if (!this.inBounds(tx, tz)) return -1;
    return this.dist[tz * MAP_W + tx];
  }

  /** Flood fill of everything reachable on foot from a tile. Used by tests. */
  reachable(startTx: number, startTz: number): Set<number> {
    const seen = new Set<number>();
    if (!this.inBounds(startTx, startTz) || this.solid(startTx, startTz)) return seen;
    const stack = [this.idx(startTx, startTz)];
    seen.add(stack[0]);
    while (stack.length) {
      const cur = stack.pop() as number;
      const cx = cur % MAP_W;
      const cz = (cur / MAP_W) | 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const nxt = cx + dx;
        const nzt = cz + dz;
        if (!this.inBounds(nxt, nzt) || this.solid(nxt, nzt)) continue;
        const ni = nzt * MAP_W + nxt;
        if (seen.has(ni)) continue;
        seen.add(ni);
        stack.push(ni);
      }
    }
    return seen;
  }
}

/** True when a circle overlaps an axis-aligned box. */
function boxOverlapsCircle(
  left: number, top: number, w: number, h: number, x: number, z: number, r: number,
): boolean {
  const cx = Math.max(left, Math.min(x, left + w));
  const cz = Math.max(top, Math.min(z, top + h));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}
