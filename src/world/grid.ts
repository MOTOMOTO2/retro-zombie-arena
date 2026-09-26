/**
 * Collision + navigation over the tile grid.
 *
 * Zombie pathing uses a flow field rebuilt from a goal tile a few times a
 * second. A full rebuild over the 96x96 grid is cheaper than running A* per
 * zombie and it gives a whole horde perfect, identical routing - which is
 * exactly the arcade behaviour we want.
 *
 * The grid keeps several fields at once, one per slot. The horde uses that to
 * chase from more than one direction: one field to the player, one to either
 * flank and one to the ground ahead of where they are running. Slots are
 * rebuilt round-robin and a rebuild is skipped outright when that slot's goal
 * tile has not moved.
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
 * Those obstacles also feed a per-tile fill map: how much of each tile the
 * furniture takes up, sampled on a 4x4 lattice and padded by roughly half a
 * body. A full tile costs seven times a clear one to walk through, so the field
 * is a small-integer Dijkstra (a dial of eight buckets, since no step costs
 * more than seven) rather than a plain breadth-first search. The horde
 * therefore routes *around* the furniture instead of grinding into the side of
 * a crate and waiting for the push-out to shuffle it free.
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

/** How many flow fields the grid holds at once. The horde runs one per goal. */
export const FIELD_SLOTS = 4;

/**
 * Walking cost of a tile by how full of furniture it is: clear, part full,
 * near enough solid. Nothing is ever *impassable* on account of furniture - a
 * crate dumped in a doorway must never seal a room off - it just costs more.
 */
const FILL_COST = [1, 4, 7] as const;
/** The dial needs one bucket per distinct distance in flight: max cost + 1. */
const DIAL = 8;
const DIAL_MASK = DIAL - 1;
/** Obstacles are padded by about half a body before their fill is measured. */
const FILL_PAD = 0.45;
/** Sample offsets across a tile, as fractions of its width. */
const FILL_SAMPLES = [0.125, 0.375, 0.625, 0.875] as const;
/** Out of sixteen samples: this many is part full, this many is near solid. */
const FILL_PART = 3;
const FILL_MOST = 8;

export class NavGrid {
  readonly base: Uint8Array;
  /** Live tile state: doors flip to floor when bought, barricades when torn. */
  readonly tiles: Uint8Array;

  private readonly dist: Int32Array[] = [];
  private readonly flowX: Int8Array[] = [];
  private readonly flowZ: Int8Array[] = [];
  private readonly fieldOrigin: number[] = [];
  /** Dijkstra's dial, reused between rebuilds so pathing never allocates. */
  private readonly dial: number[][] = [];

  /** How full of furniture each tile is: 0 clear, 1 part full, 2 near solid. */
  private readonly fill: Uint8Array;
  private fillDirty = true;
  /** Scratch counter for the fill pass: samples covered, per tile. */
  private readonly covered: Uint8Array;

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
    const cells = MAP_W * MAP_H;
    for (let s = 0; s < FIELD_SLOTS; s++) {
      this.dist.push(new Int32Array(cells));
      this.flowX.push(new Int8Array(cells));
      this.flowZ.push(new Int8Array(cells));
      this.fieldOrigin.push(-1);
    }
    for (let i = 0; i < DIAL; i++) this.dial.push([]);
    this.fill = new Uint8Array(cells);
    this.covered = new Uint8Array(cells);
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
    this.invalidateField(); // topology changed, force a flow-field rebuild
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
    this.obstaclesChanged();
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
    this.obstaclesChanged();
    return o;
  }

  clearObstacles(): void {
    this.obstacles.length = 0;
    this.seen.length = 0;
    this.movers.length = 0;
    this.buckets.clear();
    this.obstaclesChanged();
  }

  /**
   * Call after a mover has been picked up and put down somewhere else: the fill
   * map is remeasured on the next path query and every field is rebuilt.
   */
  obstaclesChanged(): void {
    this.fillDirty = true;
    this.invalidateField();
  }

  get obstacleCount(): number {
    return this.obstacles.length;
  }

  /**
   * Remeasures how much of every tile the furniture fills. Walks the obstacles
   * rather than the tiles, so the cost is a handful of point tests per box
   * instead of a sweep of the whole map.
   */
  private refreshFill(): void {
    this.fillDirty = false;
    this.covered.fill(0);
    const mark = (o: Obstacle): void => {
      if (!o.active) return;
      const x0 = o.x - o.hx - FILL_PAD;
      const x1 = o.x + o.hx + FILL_PAD;
      const z0 = o.z - o.hz - FILL_PAD;
      const z1 = o.z + o.hz + FILL_PAD;
      const tx0 = Math.floor(x0 / TILE);
      const tx1 = Math.floor(x1 / TILE);
      const tz0 = Math.floor(z0 / TILE);
      const tz1 = Math.floor(z1 / TILE);
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (!this.inBounds(tx, tz)) continue;
          let hits = 0;
          for (const fz of FILL_SAMPLES) {
            const sz = (tz + fz) * TILE;
            if (sz < z0 || sz > z1) continue;
            for (const fx of FILL_SAMPLES) {
              const sx = (tx + fx) * TILE;
              if (sx >= x0 && sx <= x1) hits++;
            }
          }
          if (hits) this.covered[this.idx(tx, tz)] = Math.min(16, this.covered[this.idx(tx, tz)] + hits);
        }
      }
    };
    for (const o of this.obstacles) mark(o);
    for (const o of this.movers) mark(o);
    for (let i = 0; i < this.fill.length; i++) {
      const c = this.covered[i];
      this.fill[i] = c >= FILL_MOST ? 2 : c >= FILL_PART ? 1 : 0;
    }
  }

  /** How full of furniture a tile is: 0 clear, 1 part full, 2 near solid. */
  fillAt(tx: number, tz: number): number {
    if (!this.inBounds(tx, tz)) return 2;
    if (this.fillDirty) this.refreshFill();
    return this.fill[tz * MAP_W + tx];
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
   * Rebuilds one slot's flow field toward a goal tile. Returns false when the
   * goal is not walkable, in which case the slot is left as it was.
   *
   * Costs are the small integers in FILL_COST, so this is Dijkstra on a dial:
   * everything still in flight sits within `DIAL - 1` of the distance being
   * processed, which is exactly what a ring of that many buckets holds.
   */
  buildFlowField(
    goalTx: number, goalTz: number, tornBarricades: Set<number>, slot = 0,
  ): boolean {
    if (slot < 0 || slot >= FIELD_SLOTS) return false;
    if (!this.inBounds(goalTx, goalTz)) return false;
    if (this.solidForZombie(goalTx, goalTz, tornBarricades)) return false;
    if (this.fillDirty) this.refreshFill();

    const goal = this.idx(goalTx, goalTz);
    if (goal === this.fieldOrigin[slot]) return true;

    const dist = this.dist[slot];
    const flowX = this.flowX[slot];
    const flowZ = this.flowZ[slot];
    dist.fill(-1);
    flowX.fill(0);
    flowZ.fill(0);
    for (const bucket of this.dial) bucket.length = 0;

    dist[goal] = 0;
    this.dial[0].push(goal);
    let pending = 1;

    for (let d = 0; pending > 0; d++) {
      const bucket = this.dial[d & DIAL_MASK];
      while (bucket.length) {
        const cur = bucket.pop() as number;
        pending--;
        // A cheaper route to this tile turned up after it was queued.
        if (dist[cur] !== d) continue;
        const cx = cur % MAP_W;
        const cz = (cur / MAP_W) | 0;

        for (const [dx, dz] of NEIGHBOURS) {
          const nxt = cx + dx;
          const nzt = cz + dz;
          if (!this.inBounds(nxt, nzt)) continue;
          const ni = nzt * MAP_W + nxt;
          if (this.solidForZombie(nxt, nzt, tornBarricades)) continue;
          const nd = d + FILL_COST[this.fill[ni]];
          const was = dist[ni];
          if (was >= 0 && was <= nd) continue;
          dist[ni] = nd;
          // Point back the way we came: that is the direction of travel.
          flowX[ni] = -dx;
          flowZ[ni] = -dz;
          this.dial[nd & DIAL_MASK].push(ni);
          pending++;
        }
      }
    }

    this.fieldOrigin[slot] = goal;
    return true;
  }

  /** Forces the next buildFlowField call to recompute even for the same goal. */
  invalidateField(): void {
    for (let s = 0; s < FIELD_SLOTS; s++) this.fieldOrigin[s] = -1;
  }

  /** Step direction toward the goal from a tile, or null if unreachable. */
  flowAt(tx: number, tz: number, slot = 0): { dx: number; dz: number; dist: number } | null {
    if (!this.inBounds(tx, tz)) return null;
    const i = tz * MAP_W + tx;
    const dist = this.dist[slot];
    if (dist[i] < 0) return null;
    return { dx: this.flowX[slot][i], dz: this.flowZ[slot][i], dist: dist[i] };
  }

  /** Path cost to the flow-field goal, or -1 when unreachable. */
  distanceAt(tx: number, tz: number, slot = 0): number {
    if (!this.inBounds(tx, tz)) return -1;
    return this.dist[slot][tz * MAP_W + tx];
  }

  /**
   * The nearest tile to (tx, tz) a body could actually stand in, searched
   * outward in rings. Furniture is avoided if there is anywhere clear to go and
   * tolerated if there is not. Null when the whole neighbourhood is walled in.
   */
  nearestOpen(
    tx: number, tz: number, tornBarricades: Set<number>, rings = 5,
  ): { tx: number; tz: number } | null {
    let fallback: { tx: number; tz: number } | null = null;
    for (let r = 0; r <= rings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the shell of each ring: the inside was covered already.
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = tx + dx;
          const nz = tz + dz;
          if (!this.inBounds(nx, nz)) continue;
          if (this.solidForZombie(nx, nz, tornBarricades)) continue;
          if (this.fillAt(nx, nz) < 2) return { tx: nx, tz: nz };
          fallback ??= { tx: nx, tz: nz };
        }
      }
    }
    return fallback;
  }

  /**
   * Line of sight that also refuses to cut through furniture. A body uses this
   * to decide whether it can walk straight somewhere; bullets and eyes use
   * plain `lineOfSight`, because you can see and shoot over a crate.
   */
  clearWalk(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) return this.fillAt(Math.floor(x0 / TILE), Math.floor(z0 / TILE)) < 2;
    if (!this.lineOfSight(x0, z0, x1, z1)) return false;
    const steps = Math.max(1, Math.ceil(d / (TILE * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const tx = Math.floor((x0 + dx * t) / TILE);
      const tz = Math.floor((z0 + dz * t) / TILE);
      if (this.fillAt(tx, tz) >= 2) return false;
    }
    return true;
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
