/**
 * Collision + navigation over the tile grid.
 *
 * Zombie pathing uses a breadth-first flow field rebuilt from the player's tile
 * a few times a second. With a 48x40 grid that is ~1900 cells, so a full rebuild
 * is cheaper than running A* per zombie and it gives a whole horde perfect,
 * identical routing - which is exactly the arcade behaviour we want.
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
   * Pushes a circle out of any solid tile it overlaps. Axis-separated so the
   * body slides along walls instead of sticking - the classic arcade feel.
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

    for (let pass = 0; pass < 2; pass++) {
      const minTx = Math.floor((px - r) / TILE);
      const maxTx = Math.floor((px + r) / TILE);
      const minTz = Math.floor((pz - r) / TILE);
      const maxTz = Math.floor((pz + r) / TILE);

      for (let tz = minTz; tz <= maxTz; tz++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (passable && passable.has(this.idx(tx, tz))) continue;
          if (!this.solid(tx, tz)) continue;

          const left = tx * TILE;
          const top = tz * TILE;
          const cx = Math.max(left, Math.min(px, left + TILE));
          const cz = Math.max(top, Math.min(pz, top + TILE));
          let dx = px - cx;
          let dz = pz - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;

          hitWall = true;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            px += (dx / d) * (r - d);
            pz += (dz / d) * (r - d);
          } else {
            // Dead centre of a tile: eject along the shallowest axis.
            dx = px - (left + TILE / 2);
            dz = pz - (top + TILE / 2);
            if (Math.abs(dx) > Math.abs(dz)) px += dx > 0 ? r : -r;
            else pz += dz > 0 ? r : -r;
          }
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
