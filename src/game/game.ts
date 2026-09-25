/**
 * The game loop: world, horde, economy, rounds and every effect that hangs off
 * them. Everything it needs is built once in the constructor and then pooled,
 * so a run never allocates in the hot path.
 */

import * as THREE from 'three';

import { audio, type ZombieVoice } from '../core/audio.ts';
import { Input } from '../core/input.ts';
import { Rng } from '../core/rng.ts';
import { RetroPipeline, type RetroQuality } from '../core/retro.ts';
import { ParticleField, applyLight, flatMaterial } from '../gfx/models.ts';
import { textures } from '../gfx/textures.ts';
import { NavGrid } from '../world/grid.ts';
import { buildLevel, fogColorAt, type BuiltLevel } from '../world/build.ts';
import { dressLevel } from '../world/dressing.ts';
import {
  TILE,
  T_FLOOR,
  WALL_H,
  type Layout,
  type ZoneId,
  generateLayout,
  getZone,
  randomSeed,
  tileCenter,
  worldToTile,
  zoneAt,
} from '../world/mapdata.ts';
import {
  BarricadeProp,
  DoorProp,
  MysteryBox,
  PerkMachine,
  WallBuy,
  buildProps,
  disposeProps,
  propGroups,
  type PropSet,
} from '../world/props.ts';
import { Enemy, EnemyPool, rayHitsEnemy } from './enemy.ts';
import { Hud, type MinimapBlip } from './hud.ts';
import { EYE_HEIGHT, Player } from './player.ts';
import {
  BOX_MOVE_MAX,
  BOX_MOVE_MIN,
  CARPENTER_SCORE,
  MYSTERY_BOX_COST,
  NUKE_SCORE,
  PACK_COST,
  PERK_INFO,
  POWERUPS,
  POWERUP_IDS,
  POWERUP_LIFETIME,
  packedName,
  planRound,
  roundBonus,
  scoreForHit,
  scoreForKill,
  type EnemyKind,
  type PowerUpId,
  type SpawnPlan,
} from './rules.ts';
import { ViewModel } from './viewmodel.ts';
import { BOX_POOL, boxWeights, getWeapon, shotDamage, type WeaponDef } from './weapons.ts';

export type GameState = 'boot' | 'menu' | 'playing' | 'paused' | 'gameover';

export type RunStats = {
  round: number;
  kills: number;
  headshots: number;
  points: number;
  seconds: number;
};

type Projectile = {
  mesh: THREE.Mesh;
  vx: number; vy: number; vz: number;
  gravity: number;
  fuse: number;
  radius: number;
  damage: number;
  splash: number;
  direct: number;
  owner: 'player';
  alive: boolean;
  kind: 'rocket' | 'plasma' | 'grenade';
};

type Drop = {
  group: THREE.Group;
  id: PowerUpId;
  x: number; z: number;
  life: number;
  alive: boolean;
};

const BLOOD_COLOR = new THREE.Color(0xa01810);
const SPARK_COLOR = new THREE.Color(0xffd48a);
const DUST_COLOR = new THREE.Color(0x9a9282);
const EMBER_COLOR = new THREE.Color(0xff8a2a);

const INTERACT_RANGE = 5.2;

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly retro: RetroPipeline;
  readonly hud = new Hud();
  readonly input: Input;
  readonly player = new Player();
  readonly viewmodel = new ViewModel();

  private grid!: NavGrid;
  private layout!: Layout;
  private level!: BuiltLevel;
  private props!: PropSet;
  private readonly box = new MysteryBox();
  /** True while the world built at boot has not been played yet. */
  private worldFresh = false;
  private readonly pool = new EnemyPool();
  private readonly particles = new ParticleField(1200, 0.2);
  private readonly rng = new Rng(Date.now() >>> 0);
  private readonly torch: THREE.PointLight;
  private readonly muzzleLight = new THREE.PointLight(0xffc070, 0, 26, 2);
  private muzzleLightTimer = 0;
  private readonly fog = new THREE.Fog(0x1c1a1c, 16, 120);

  private readonly tracers: THREE.Mesh[] = [];
  private readonly tracerLife: number[] = [];
  private readonly decals: THREE.Mesh[] = [];
  private decalCursor = 0;
  private readonly projectiles: Projectile[] = [];
  private readonly drops: Drop[] = [];
  private readonly dropGeoCache = new Map<PowerUpId, THREE.Group>();

  state: GameState = 'boot';
  onStateChange: (s: GameState) => void = () => {};
  onGameOver: (stats: RunStats) => void = () => {};

  private round = 0;
  private plan: SpawnPlan = planRound(1);
  private spawned = 0;
  private killedThisRound = 0;
  private spawnTimer = 0;
  private roundPhase: 'intro' | 'active' | 'clear' = 'intro';
  private phaseTimer = 0;
  private runSeconds = 0;

  private readonly openZones = new Set<ZoneId>(['lobby']);
  private readonly torn = new Set<number>();
  private readonly activePowerups = new Map<PowerUpId, number>();
  private killsSinceDrop = 0;
  private dropsThisRound = 0;

  private boxRolls = 0;
  private boxLimit = 5;
  private boxState: 'idle' | 'rolling' | 'offer' | 'closing' | 'moving' = 'idle';
  private boxTimer = 0;
  private boxOffer: string | null = null;
  private boxBuyer = false;

  private repairHold = 0;
  private fieldTimer = 0;
  private bobPhase = 0;
  private stepTimer = 0;
  private shake = 0;
  private damageFlash = 0;
  private fadeIn = 0;
  private elapsed = 0;
  private lookDX = 0;
  private lookDY = 0;
  private fovBase = 80;

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly fogTarget = new THREE.Color(0x1c1a1c);
  private readonly tmpLight = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, quality: RetroQuality) {
    this.retro = new RetroPipeline(canvas, quality);
    this.camera = new THREE.PerspectiveCamera(this.fovBase, this.retro.aspect, 0.1, 260);
    this.input = new Input(canvas, () => {});

    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x1c1a1c);
    // The level carries its lighting in its vertex colours, so ambient sits at
    // full strength and simply reproduces the bake. Moving things are tinted
    // by the light probe instead, so they pick up the same lamps.
    // Intensity of PI exactly cancels the Lambert 1/PI term, so a surface with
    // a baked vertex colour of 1.0 renders at its full texture value.
    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI));

    this.scene.add(this.box.group);
    this.scene.add(this.pool.group);
    this.scene.add(this.particles.points);

    // A dim lantern glow around the player, just enough to read a face at arm's length.
    this.torch = new THREE.PointLight(0xffd2a0, 9, 16, 2);
    this.scene.add(this.torch);
    this.scene.add(this.muzzleLight);
    this.viewmodel.init(this.retro.renderer);
    this.viewmodel.onEvent = (e) => audio.mech(e);

    this.buildTracerPool();
    this.buildDecalPool();
    this.buildWorld(randomSeed());
    this.worldFresh = true;

    this.viewmodel.equip('sidearm');
    this.resize();
  }

  /* ------------------------------------------------------------- pooling */

  private buildTracerPool(): void {
    const geo = new THREE.BoxGeometry(0.05, 0.05, 1);
    geo.translate(0, 0, -0.5);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this.tracers.push(m);
      this.tracerLife.push(0);
    }
  }

  private buildDecalPool(): void {
    const tex = textures();
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 96; i++) {
      const useBlood = i % 3 === 0;
      const mat = new THREE.MeshBasicMaterial({
        map: useBlood ? tex.blood[i % tex.blood.length] : tex.bullet,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        opacity: 0,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.userData.blood = useBlood;
      this.scene.add(m);
      this.decals.push(m);
    }
  }

  private placeDecal(
    x: number, y: number, z: number, nx: number, nz: number, blood: boolean, scale: number,
  ): void {
    // Find the next decal of the right flavour, wrapping around the pool.
    for (let tries = 0; tries < this.decals.length; tries++) {
      const m = this.decals[this.decalCursor];
      this.decalCursor = (this.decalCursor + 1) % this.decals.length;
      if (m.userData.blood !== blood) continue;
      m.visible = true;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = blood ? 0.85 : 0.95;
      this.level.probe.sample(x, z, mat.color);
      mat.color.multiplyScalar(1.3);
      m.position.set(x + nx * 0.03, y, z + nz * 0.03);
      m.scale.setScalar(scale);
      if (nx === 0 && nz === 0) {
        m.rotation.set(-Math.PI / 2, 0, this.rng.range(0, Math.PI * 2));
      } else {
        m.rotation.set(0, Math.atan2(nx, nz), this.rng.range(0, Math.PI * 2) * 0.12);
      }
      return;
    }
  }

  private fireTracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    for (let i = 0; i < this.tracers.length; i++) {
      if (this.tracerLife[i] > 0) continue;
      const m = this.tracers[i];
      const dist = from.distanceTo(to);
      m.position.copy(from);
      m.lookAt(to);
      m.scale.set(1, 1, Math.max(0.2, dist));
      m.visible = true;
      (m.material as THREE.MeshBasicMaterial).color.setHex(color);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.95;
      this.tracerLife[i] = 0.055;
      return;
    }
  }

  /* --------------------------------------------------------------- world */

  /** Throws away the current asylum and builds a new one from a seed. */
  private buildWorld(seed: number): void {
    if (this.level) {
      this.scene.remove(this.level.group);
      this.level.dispose();
      for (const g of propGroups(this.props)) this.scene.remove(g);
      disposeProps(this.props);
    }
    this.layout = generateLayout(seed);
    this.grid = new NavGrid(this.layout.tiles);
    this.level = buildLevel(this.layout, dressLevel(this.layout));
    this.scene.add(this.level.group);
    this.props = buildProps(this.layout, this.level.probe);
    for (const g of propGroups(this.props)) this.scene.add(g);
    this.box.moveTo(this.layout.boxPads[0], 0, this.level.probe);
    const spawnZone = getZone(this.layout, this.layout.spawnZone);
    this.fog.color.copy(fogColorAt(this.layout, spawnZone.id));
  }

  /** The seed of the asylum currently loaded. */
  get seed(): number {
    return this.layout.seed;
  }

  /** Opens a zone for spawning, and anything joined to it by an open archway. */
  private openZone(id: ZoneId): void {
    if (this.openZones.has(id)) return;
    this.openZones.add(id);
    for (const [a, b] of this.layout.openLinks) {
      if (a === id) this.openZone(b);
      if (b === id) this.openZone(a);
    }
  }

  /* --------------------------------------------------------------- setup */

  resize(): void {
    this.retro.resize(window.innerWidth, window.innerHeight);
    this.camera.aspect = this.retro.aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodel.setAspect(this.retro.aspect);
  }

  setQuality(q: RetroQuality): void {
    this.retro.setQuality(q);
    this.resize();
  }

  setFov(fov: number): void {
    this.fovBase = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private setState(s: GameState): void {
    this.state = s;
    this.onStateChange(s);
  }

  /* --------------------------------------------------------------- start */

  /**
   * Starts a run. Every run gets a freshly generated asylum; pass a seed to
   * replay a particular one.
   */
  newRun(seed?: number): void {
    if (seed !== undefined || !this.worldFresh) this.buildWorld(seed ?? randomSeed());
    this.worldFresh = false;

    const spawn = tileCenter(this.layout.spawn.tx, this.layout.spawn.tz);
    this.player.reset(spawn.x, spawn.z);
    this.player.yaw = this.layout.spawn.yaw;
    this.player.pitch = 0;

    this.pool.reset();
    this.torn.clear();
    this.openZones.clear();
    this.openZone(this.layout.spawnZone);
    this.activePowerups.clear();
    this.projectiles.length = 0;
    this.drops.length = 0;
    this.killsSinceDrop = 0;
    this.dropsThisRound = 0;
    this.runSeconds = 0;
    this.boxRolls = 0;
    this.boxLimit = this.rng.int(BOX_MOVE_MAX - BOX_MOVE_MIN + 1) + BOX_MOVE_MIN;
    this.boxState = 'idle';
    this.boxOffer = null;
    this.box.setLid(0);
    this.box.showWeapon(null);
    this.box.moveTo(this.layout.boxPads[0], 0, this.level.probe);
    this.props.pack.showWeapon(null);
    this.props.pack.setPowered(false);
    this.props.power.setOn(false);
    for (const m of this.props.machines) {
      m.setPowered(false);
      m.bought = false;
    }

    // Rebuild the map state: every door shut, every window boarded.
    this.grid.tiles.set(this.grid.base);
    this.grid.invalidateField();
    for (const d of this.props.doors) d.reset();
    for (const b of this.props.barricades) {
      while (b.addBoard());
    }
    for (const m of this.decals) m.visible = false;
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const d of this.drops) this.scene.remove(d.group);

    this.viewmodel.reset();
    this.equipCurrent();

    this.round = 0;
    this.killedThisRound = 0;
    this.roundPhase = 'clear';
    this.phaseTimer = 2.2;
    this.fadeIn = 0;
    this.shake = 0;
    this.damageFlash = 0;

    this.hud.show(true);
    this.hud.setPoints(this.player.points);
    this.hud.setRound(1);
    this.hud.toggleMap(false);
    this.hud.setPerks([]);
    this.hud.setGrenades(this.player.grenades, this.player.hasGrenades);
    this.syncAmmoHud();

    this.setState('playing');
    audio.startMusic();
    this.hud.banner('ST. MERCY ASYLUM', 2.6, '#e8e2ce');
    this.hud.toast(`${getZone(this.layout, this.layout.spawnZone).name}  ·  LAYOUT #${this.layout.seed}`, '#bdb6a0', 3.2);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.input.exitLock();
  }

  resumeGame(): void {
    if (this.state !== 'paused') return;
    this.setState('playing');
  }

  abandon(): void {
    this.hud.show(false);
    audio.stopMusic();
    this.setState('menu');
  }

  get stats(): RunStats {
    return {
      round: Math.max(1, this.round),
      kills: this.player.kills,
      headshots: this.player.headshots,
      points: this.player.totalPoints,
      seconds: Math.floor(this.runSeconds),
    };
  }

  /* --------------------------------------------------------------- rounds */

  private startRound(n: number): void {
    this.round = n;
    this.plan = planRound(n);
    this.spawned = 0;
    this.killedThisRound = 0;
    this.dropsThisRound = 0;
    this.spawnTimer = this.plan.isHoundRound ? 4.5 : 2.6;
    this.roundPhase = 'active';
    this.hud.setRound(n);
    audio.roundStart(n);
    if (this.plan.isHoundRound) {
      this.hud.banner('HELLHOUNDS', 2.6, '#ff6a2a');
      this.hud.toast('THEY COME IN PACKS', '#ff6a2a', 2.6);
    } else {
      this.hud.banner(`ROUND ${n}`, 2.0);
    }
  }

  private endRound(): void {
    this.roundPhase = 'clear';
    this.phaseTimer = 6.5;
    const bonus = roundBonus(this.round);
    this.player.award(bonus);
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(bonus);
    this.hud.toast(`ROUND ${this.round} CLEARED  +${bonus}`, '#7bd14a', 2.6);
    audio.roundEnd();
    if (this.plan.isHoundRound) this.applyPowerUp('maxammo', false);
  }

  /** Windows in rooms the player has opened, weighted toward nearby ones. */
  private pickSpawnBarricade(): BarricadeProp | null {
    const candidates: BarricadeProp[] = [];
    const weights: number[] = [];
    for (const b of this.props.barricades) {
      if (!this.openZones.has(b.def.zone)) continue;
      const d = Math.hypot(b.center.x - this.player.x, b.center.z - this.player.z);
      candidates.push(b);
      // Near windows are far likelier, but distant ones never drop to zero.
      weights.push(1 / (1 + d * 0.05) + 0.08);
    }
    if (!candidates.length) return null;
    return candidates[this.rng.weighted(weights)];
  }

  private pickKind(): EnemyKind {
    const mix = this.plan.mix;
    return mix[this.rng.weighted(mix.map((m) => m.weight))].kind;
  }

  private trySpawn(): void {
    if (this.spawned >= this.plan.total) return;
    if (this.pool.liveCount >= this.plan.maxAlive) return;
    const barricade = this.pickSpawnBarricade();
    if (!barricade) return;
    const kind = this.pickKind();
    const enemy = this.pool.acquire(kind);
    if (!enemy) return;

    const outside = {
      x: barricade.center.x + barricade.def.dx * TILE * 2.0,
      z: barricade.center.z + barricade.def.dz * TILE * 2.0,
    };
    enemy.spawn(kind, outside.x, outside.z, this.plan.health, this.round, barricade, this.rng);
    this.spawned++;
  }

  /* ---------------------------------------------------------------- input */

  private handleLook(dt: number): void {
    const { dx, dy } = this.input.takeMouse();
    this.lookDX = dx / Math.max(dt, 1 / 240) * 0.004;
    this.lookDY = dy / Math.max(dt, 1 / 240) * 0.004;
    const scale = this.viewmodel.scopeView ? 0.3 : this.input.aim ? 0.55 : 1;
    this.player.yaw -= dx * scale;
    this.player.pitch -= dy * scale;
    const limit = Math.PI / 2 - 0.02;
    this.player.pitch = Math.max(-limit, Math.min(limit, this.player.pitch));
  }

  private handleActions(): void {
    const p = this.player;
    if (!p.alive) return;

    if (this.input.consume('reload')) this.startReload();
    if (this.input.consume('melee') && p.tryMelee()) {
      this.viewmodel.setPose('melee', 0.52);
    }
    if (this.input.consume('grenade') && p.hasGrenades && p.tryGrenade()) {
      this.viewmodel.setPose('throw', 0.7);
      this.throwGrenade();
      this.hud.setGrenades(p.grenades, p.hasGrenades);
    }

    const wheel = this.input.takeWheel();
    const wantSwap =
      this.input.consume('swap') || wheel !== 0 ||
      (this.input.consume('slot1') && p.activeSlot !== 0) ||
      (this.input.consume('slot2') && p.activeSlot !== 1);
    if (wantSwap && p.trySwap()) {
      this.viewmodel.setPose('lower', 0.27);
    }

    if (this.input.consume('map')) this.hud.toggleMap(!this.hud.mapVisible);

    const def = p.weapon;
    const wantsFire = def.mode === 'auto' ? this.input.fire : this.input.takeFirePress();
    if (wantsFire) this.attemptFire();
  }

  /** Starts a reload if one is possible, and the matching animation. */
  private startReload(): boolean {
    const p = this.player;
    const empty = p.slot.mag === 0;
    if (!p.tryReload()) return false;
    this.viewmodel.setPose('reload', p.reloadRemaining, { empty });
    return true;
  }

  /** Puts the weapon in the active slot into the player's hands. */
  private equipCurrent(): void {
    this.viewmodel.equip(this.player.slot.id, this.player.slot.packed);
  }

  /* ---------------------------------------------------------------- combat */

  private attemptFire(): void {
    const outcome = this.player.tryFire();
    if (outcome.kind === 'none') return;
    if (outcome.kind === 'dry') {
      audio.dryFire();
      if (this.player.slot.reserve > 0) this.startReload();
      return;
    }
    if (outcome.kind !== 'shoot') return;

    const def = outcome.def;
    const packed = this.player.slot.packed;
    // Firing out of a shell-by-shell reload abandons it.
    if (def.shellReload) this.viewmodel.cancelShells();
    this.viewmodel.kick(def.kick * (this.input.aim ? 0.6 : 1));
    this.muzzleLightTimer = 0.06;
    this.muzzleLight.color.setHex(def.tracer || 0xffc070);
    this.shake = Math.min(3.2, this.shake + def.shake * 0.35);
    audio.shot(def, { x: this.player.x, z: this.player.z });
    this.syncAmmoHud();

    const origin = this.tmpV.set(this.camera.position.x, this.camera.position.y, this.camera.position.z).clone();
    this.camera.getWorldDirection(this.tmpDir);
    const base = this.tmpDir.clone();

    if (def.kind === 'rocket' || def.kind === 'plasma') {
      this.spawnProjectile(def, origin, base, packed);
      return;
    }
    if (def.kind === 'cone') {
      this.coneBlast(origin, base, def, packed);
      return;
    }

    const spread = def.spread + (this.input.aim ? 0 : def.bloom * Math.min(1, this.player.planarSpeed / 8));
    for (let i = 0; i < outcome.pellets; i++) {
      const dir = base.clone();
      if (spread > 0) {
        dir.x += this.rng.range(-spread, spread);
        dir.y += this.rng.range(-spread, spread);
        dir.z += this.rng.range(-spread, spread);
        dir.normalize();
      }
      this.hitscan(origin, dir, def, packed, i === 0);
    }
  }

  private hitscan(
    origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, packed: boolean, tracer: boolean,
  ): void {
    const wall = this.grid.raycast(origin.x, origin.z, dir.x, dir.z, def.range, this.torn);
    // Convert the 2D wall distance into a 3D limit, and clip on floor/ceiling.
    let limit = wall.hit ? wall.dist / Math.max(0.0001, Math.hypot(dir.x, dir.z)) : def.range;
    if (dir.y < -0.001) limit = Math.min(limit, (0 - origin.y) / dir.y);
    if (dir.y > 0.001) limit = Math.min(limit, (WALL_H - origin.y) / dir.y);
    limit = Math.min(limit, def.range);

    const best: { enemy: Enemy | null; dist: number; head: boolean } = {
      enemy: null, dist: limit, head: false,
    };
    this.pool.forEachLive((e) => {
      const r = rayHitsEnemy(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, e, limit);
      if (!r) return;
      if (!best.enemy || r.dist < best.dist) {
        best.enemy = e;
        best.dist = r.dist;
        best.head = r.head;
      }
    });

    const muzzle = this.viewmodel.muzzleWorld(this.camera, new THREE.Vector3());
    const hitPoint = new THREE.Vector3().copy(dir).multiplyScalar(best.dist).add(origin);
    if (tracer && def.tracer) this.fireTracer(muzzle, hitPoint, def.tracer);

    const struck = best.enemy;
    if (struck) {
      const dmg = shotDamage(def, {
        head: best.head,
        doubleTap: this.player.perks.has('doubletap'),
        instaKill: this.activePowerups.has('instakill'),
        packed,
      });
      this.damageEnemy(struck, dmg, best.head, false, hitPoint);
      return;
    }

    // Wall impact: a puff of dust, a hole, and a click you can hear.
    if (limit < def.range - 0.01) {
      this.placeDecal(hitPoint.x, hitPoint.y, hitPoint.z, wall.nx, wall.nz, false, 0.42);
      for (let i = 0; i < 4; i++) {
        this.particles.spawn(
          hitPoint.x, hitPoint.y, hitPoint.z,
          this.rng.range(-3, 3) + wall.nx * 3, this.rng.range(1, 5), this.rng.range(-3, 3) + wall.nz * 3,
          DUST_COLOR, this.rng.range(0.25, 0.6), 22,
        );
      }
      audio.wallHit({ x: hitPoint.x, z: hitPoint.z });
    }
  }

  /** Thunderclap: everything inside a wide forward cone is thrown and gibbed. */
  private coneBlast(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, packed: boolean): void {
    const hits: Enemy[] = [];
    this.pool.forEachLive((e) => {
      const dx = e.x - origin.x;
      const dz = e.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > def.range || d < 0.001) return;
      const dot = (dx / d) * dir.x + (dz / d) * dir.z;
      if (dot < 0.55) return;
      if (!this.grid.lineOfSight(origin.x, origin.z, e.x, e.z)) return;
      hits.push(e);
    });
    for (const e of hits) {
      this.damageEnemy(
        e, shotDamage(def, { head: false, doubleTap: false, instaKill: false, packed }),
        false, true, new THREE.Vector3(e.x, e.headY, e.z),
      );
    }
    this.shake = 4;
  }

  private spawnProjectile(
    def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, packed: boolean,
  ): void {
    const isPlasma = def.kind === 'plasma';
    const mat = new THREE.MeshBasicMaterial({ color: isPlasma ? 0x6effd8 : 0xffa24d });
    const geo = isPlasma
      ? new THREE.BoxGeometry(0.4, 0.4, 0.9)
      : new THREE.BoxGeometry(0.3, 0.3, 1.2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin).addScaledVector(dir, 1.2);
    this.scene.add(mesh);

    const speed = isPlasma ? 78 : 52;
    const mult = packed ? 2.4 : 1;
    this.projectiles.push({
      mesh,
      vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
      gravity: 0,
      fuse: 4,
      radius: def.splashRadius,
      damage: def.splashDamage * mult,
      splash: def.splashRadius,
      direct: def.damage * mult,
      owner: 'player',
      alive: true,
      kind: isPlasma ? 'plasma' : 'rocket',
    });
  }

  private throwGrenade(): void {
    const def = getWeapon('frag');
    this.camera.getWorldDirection(this.tmpDir);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.5, 0.42),
      flatMaterial(0x3c4a2c),
    );
    mesh.position.copy(this.camera.position).addScaledVector(this.tmpDir, 1.2);
    this.scene.add(mesh);
    const speed = 34;
    this.projectiles.push({
      mesh,
      vx: this.tmpDir.x * speed,
      vy: this.tmpDir.y * speed + 6,
      vz: this.tmpDir.z * speed,
      gravity: 30,
      fuse: 2.4,
      radius: def.splashRadius,
      damage: def.splashDamage,
      splash: def.splashRadius,
      direct: 0,
      owner: 'player',
      alive: true,
      kind: 'grenade',
    });
  }

  private explode(x: number, y: number, z: number, radius: number, damage: number): void {
    audio.explosion({ x, z });
    this.shake = Math.max(this.shake, 3.4);
    for (let i = 0; i < 26; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const s = this.rng.range(6, 22);
      this.particles.spawn(
        x, y, z,
        Math.cos(a) * s, this.rng.range(4, 18), Math.sin(a) * s,
        i % 3 === 0 ? SPARK_COLOR : EMBER_COLOR, this.rng.range(0.4, 1.1), 24,
      );
    }
    this.placeDecal(x, 0.05, z, 0, 0, false, radius * 0.7);

    this.pool.forEachLive((e) => {
      const d = Math.hypot(e.x - x, e.z - z);
      if (d > radius) return;
      if (!this.grid.lineOfSight(x, z, e.x, e.z)) return;
      const falloff = 1 - d / radius;
      this.damageEnemy(
        e, damage * falloff * falloff, false, true,
        new THREE.Vector3(e.x, e.headY, e.z), { x, z },
      );
    });

    // Explosives hurt the player too - the ray gun especially.
    const pd = Math.hypot(this.player.x - x, this.player.z - z);
    if (pd < radius * 0.8 && this.player.alive) {
      const falloff = 1 - pd / (radius * 0.8);
      this.hurtPlayer(Math.round(damage * 0.12 * falloff));
    }
  }

  /**
   * Applies a hit. `from` is where it came from - the player for bullets, the
   * blast centre for explosions - which decides which way the body reels,
   * falls and sprays.
   */
  private damageEnemy(
    e: Enemy, amount: number, head: boolean, explosive: boolean, at: THREE.Vector3,
    from: { x: number; z: number } = this.player,
  ): void {
    let dirX = e.x - from.x;
    let dirZ = e.z - from.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    dirX /= len;
    dirZ /= len;
    const res = e.applyDamage(amount, head, explosive, dirX, dirZ);
    if (res.damageDealt <= 0) return;

    const doublePoints = this.activePowerups.has('doublepoints');
    const gore = res.killed ? (res.gibbed ? 26 : 14) : head ? 9 : 5;
    // Blood sprays out the far side, the way the round was travelling.
    for (let i = 0; i < gore; i++) {
      const out = this.rng.range(1, 8);
      this.particles.spawn(
        at.x, at.y, at.z,
        dirX * out + this.rng.range(-3.5, 3.5), this.rng.range(1, 10), dirZ * out + this.rng.range(-3.5, 3.5),
        BLOOD_COLOR, this.rng.range(0.3, 0.95), 28,
      );
    }
    if (res.headless) {
      // The head is gone: a fountain from the neck.
      for (let i = 0; i < 22; i++) {
        this.particles.spawn(
          e.x, e.headY - 0.35, e.z,
          this.rng.range(-2.5, 2.5) + dirX * 2, this.rng.range(6, 13), this.rng.range(-2.5, 2.5) + dirZ * 2,
          BLOOD_COLOR, this.rng.range(0.5, 1.1), 26,
        );
      }
      audio.flesh({ x: e.x, z: e.z }, true);
    }
    this.placeDecal(e.x, 0.04, e.z, 0, 0, true, this.rng.range(1.4, 2.6));
    audio.flesh({ x: e.x, z: e.z }, res.killed);

    if (!res.killed) {
      this.player.award(scoreForHit(doublePoints));
      this.hud.pointsDelta(scoreForHit(doublePoints));
      this.hud.hitmarker(false);
      this.hud.setPoints(this.player.points);
      return;
    }

    if (res.gibbed) e.model.root.visible = false;
    else if (e.kind !== 'hound' && this.rng.chance(0.65)) audio.zombieVoice({ x: e.x, z: e.z }, 'death', this.voicePitch(e));
    const kindOfKill = explosive ? 'explosive' : head ? 'head' : 'body';
    const award = scoreForKill(kindOfKill, doublePoints);
    this.player.award(award);
    this.player.kills++;
    if (head) this.player.headshots++;
    this.killedThisRound++;
    this.hud.pointsDelta(award);
    this.hud.hitmarker(true);
    this.hud.setPoints(this.player.points);
    this.maybeDropPowerUp(e.x, e.z);
  }

  private hurtPlayer(amount: number): void {
    if (amount <= 0 || !this.player.alive) return;
    const died = this.player.takeDamage(amount);
    this.damageFlash = Math.min(1, this.damageFlash + amount / 70);
    this.hud.damageFlash();
    this.hud.setHealth(this.player.healthFraction);
    audio.hurt();
    this.shake = Math.max(this.shake, 1.4);
    if (died) this.die();
  }

  private die(): void {
    audio.gameOver();
    audio.stopMusic();
    this.hud.banner('YOU DIED', 3, '#d22f26');
    this.setState('gameover');
    this.input.exitLock();
    this.onGameOver(this.stats);
  }

  /* ------------------------------------------------------------ power-ups */

  private maybeDropPowerUp(x: number, z: number): void {
    this.killsSinceDrop++;
    if (this.dropsThisRound >= 4) return;
    if (this.killsSinceDrop < 12) return;
    if (!this.rng.chance(0.085)) return;

    this.killsSinceDrop = 0;
    this.dropsThisRound++;
    const id = POWERUP_IDS[this.rng.weighted(POWERUP_IDS.map((p) => POWERUPS[p].weight))];
    this.spawnDrop(id, x, z);
  }

  private spawnDrop(id: PowerUpId, x: number, z: number): void {
    let proto = this.dropGeoCache.get(id);
    if (!proto) {
      proto = new THREE.Group();
      const info = POWERUPS[id];
      const core = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshBasicMaterial({ color: info.color }),
      );
      proto.add(core);
      const shell = new THREE.Mesh(
        new THREE.BoxGeometry(1.35, 1.35, 1.35),
        new THREE.MeshBasicMaterial({
          color: info.color, wireframe: true, transparent: true, opacity: 0.7,
        }),
      );
      proto.add(shell);
      this.dropGeoCache.set(id, proto);
    }

    const group = proto.clone();
    const light = new THREE.PointLight(POWERUPS[id].color, 26, 16, 2);
    group.add(light);
    group.position.set(x, 1.4, z);
    this.scene.add(group);
    this.drops.push({ group, id, x, z, life: POWERUP_LIFETIME, alive: true });
  }

  private applyPowerUp(id: PowerUpId, announce = true): void {
    const info = POWERUPS[id];
    if (announce) {
      audio.powerUp();
      this.hud.toast(info.name, `#${info.color.toString(16).padStart(6, '0')}`, 2.2);
    }
    switch (id) {
      case 'maxammo':
        this.player.maxAmmo();
        this.syncAmmoHud();
        this.hud.setGrenades(this.player.grenades, this.player.hasGrenades);
        break;
      case 'nuke': {
        const killed = this.pool.killAll();
        for (const e of killed) {
          this.player.kills++;
          this.killedThisRound++;
          for (let i = 0; i < 10; i++) {
            this.particles.spawn(
              e.x, e.headY, e.z,
              this.rng.range(-8, 8), this.rng.range(2, 12), this.rng.range(-8, 8),
              BLOOD_COLOR, this.rng.range(0.3, 0.9), 26,
            );
          }
        }
        this.player.award(NUKE_SCORE);
        this.hud.pointsDelta(NUKE_SCORE);
        this.hud.setPoints(this.player.points);
        this.retro.setTint(0xa0ff60, 0.55);
        this.shake = 3;
        audio.explosion();
        break;
      }
      case 'carpenter': {
        let repaired = 0;
        for (const b of this.props.barricades) {
          while (b.boards < b.maxBoards) {
            b.addBoard();
            repaired++;
          }
          this.torn.delete(this.grid.idx(b.def.tx, b.def.tz));
        }
        this.grid.invalidateField();
        if (repaired) audio.boardBreak({ x: this.player.x, z: this.player.z });
        this.player.award(CARPENTER_SCORE);
        this.hud.pointsDelta(CARPENTER_SCORE);
        this.hud.setPoints(this.player.points);
        break;
      }
      case 'instakill':
      case 'doublepoints':
        this.activePowerups.set(id, info.duration);
        break;
    }
  }

  /* --------------------------------------------------------- interaction */

  private findInteractable(): {
    label: string; cost: number; affordable: boolean; act: () => void;
    repair: BarricadeProp | null;
  } | null {
    const p = this.player;
    const px = p.x;
    const pz = p.z;
    this.camera.getWorldDirection(this.tmpDir);
    const fx = this.tmpDir.x;
    const fz = this.tmpDir.z;

    type Cand = {
      d: number; label: string; cost: number; act: () => void; repair: BarricadeProp | null;
    };
    const best: { cand: Cand | null } = { cand: null };

    const consider = (
      x: number, z: number, label: string, cost: number, act: () => void,
      range = INTERACT_RANGE, repair: BarricadeProp | null = null,
    ): void => {
      const dx = x - px;
      const dz = z - pz;
      const d = Math.hypot(dx, dz);
      if (d > range) return;
      if (d > 0.4) {
        const dot = (dx / d) * fx + (dz / d) * fz;
        if (dot < 0.25) return;
      }
      if (!best.cand || d < best.cand.d) best.cand = { d, label, cost, act, repair };
    };

    for (const door of this.props.doors) {
      if (door.open) continue;
      consider(
        door.center.x, door.center.z,
        `OPEN ${door.def.label}`, door.def.cost,
        () => this.buyDoor(door), 6.2,
      );
    }

    for (const w of this.props.wallBuys) {
      const def = getWeapon(w.weaponId);
      const owned = p.hasWeapon(w.weaponId) >= 0;
      const cost = owned ? Math.round(def.wallCost / 2) : def.wallCost;
      consider(
        w.center.x, w.center.z,
        owned ? `${def.name} AMMO` : `BUY ${def.name}`, cost,
        () => this.buyWallWeapon(w),
      );
    }

    for (const m of this.props.machines) {
      const info = PERK_INFO[m.id];
      if (p.perks.has(m.id)) continue;
      if (!m.powered) {
        consider(m.center.x, m.center.z, `${info.name} — NO POWER`, 0, () => audio.deny());
        continue;
      }
      consider(m.center.x, m.center.z, `BUY ${info.name}`, info.cost, () => this.buyPerk(m));
    }

    if (!this.props.power.on) {
      consider(
        this.props.power.center.x, this.props.power.center.z,
        'TURN ON THE POWER', 0, () => this.turnOnPower(), 5.5,
      );
    }

    if (this.props.pack.powered) {
      consider(
        this.props.pack.center.x, this.props.pack.center.z,
        p.slot.packed ? 'ALREADY PACKED' : `PACK-A-PUNCH ${p.weapon.name}`,
        p.slot.packed ? 0 : PACK_COST,
        () => this.packWeapon(), 5.5,
      );
    }

    const box = this.box;
    if (this.boxState === 'offer' && this.boxBuyer && this.boxOffer) {
      consider(
        box.center.x, box.center.z,
        `TAKE ${getWeapon(this.boxOffer).name}`, 0, () => this.takeBoxWeapon(), 5.5,
      );
    } else if (this.boxState === 'idle') {
      consider(
        box.center.x, box.center.z,
        'MYSTERY BOX', MYSTERY_BOX_COST, () => this.rollBox(), 5.5,
      );
    }

    for (const b of this.props.barricades) {
      if (b.boards >= b.maxBoards) continue;
      consider(b.center.x, b.center.z, 'HOLD TO REBOARD', 0, () => {}, 4.4, b);
    }

    const found = best.cand;
    if (!found) return null;
    return {
      label: found.label,
      cost: found.cost,
      affordable: found.cost === 0 || p.points >= found.cost,
      act: found.act,
      repair: found.repair,
    };
  }

  private buyDoor(door: DoorProp): void {
    if (!this.player.spend(door.def.cost)) {
      audio.deny();
      return;
    }
    door.open = true;
    for (let z = door.def.rect.z; z < door.def.rect.z + door.def.rect.h; z++) {
      for (let x = door.def.rect.x; x < door.def.rect.x + door.def.rect.w; x++) {
        this.grid.set(x, z, T_FLOOR);
      }
    }
    for (const zone of door.def.connects) this.openZone(zone);
    audio.doorOpen({ x: door.center.x, z: door.center.z });
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(-door.def.cost);
    this.hud.toast(door.def.label, '#e8e2ce', 1.8);
  }

  private buyWallWeapon(w: WallBuy): void {
    const def = getWeapon(w.weaponId);
    const owned = this.player.hasWeapon(w.weaponId) >= 0;

    if (w.weaponId === 'frag') {
      const cost = def.wallCost;
      if (this.player.grenades >= 4 && this.player.hasGrenades) {
        audio.deny();
        return;
      }
      if (!this.player.spend(cost)) {
        audio.deny();
        return;
      }
      this.player.hasGrenades = true;
      this.player.grenades = 4;
      this.hud.setGrenades(this.player.grenades, true);
      this.finishPurchase(cost, 'FRAG GRENADES');
      return;
    }

    if (owned) {
      const cost = Math.round(def.wallCost / 2);
      if (!this.player.refillAmmo(w.weaponId)) {
        audio.deny();
        return;
      }
      if (!this.player.spend(cost)) {
        audio.deny();
        return;
      }
      this.syncAmmoHud();
      this.finishPurchase(cost, `${def.name} AMMO`);
      return;
    }

    if (!this.player.spend(def.wallCost)) {
      audio.deny();
      return;
    }
    this.player.giveWeapon(w.weaponId);
    this.equipCurrent();
    this.viewmodel.setPose('raise', 0.32);
    this.syncAmmoHud();
    this.finishPurchase(def.wallCost, def.name);
  }

  private buyPerk(m: PerkMachine): void {
    const info = PERK_INFO[m.id];
    if (this.player.perks.size >= 4) {
      audio.deny();
      this.hud.toast('NO ROOM FOR ANOTHER PERK', '#d22f26', 1.8);
      return;
    }
    if (!this.player.spend(info.cost)) {
      audio.deny();
      return;
    }
    this.player.perks.add(m.id);
    m.bought = true;
    if (m.id === 'juggernog') this.player.health = this.player.maxHealth;
    audio.perkJingle();
    this.hud.setPerks([...this.player.perks]);
    this.hud.setHealth(this.player.healthFraction);
    this.finishPurchase(info.cost, info.name, false);
  }

  private turnOnPower(): void {
    this.props.power.setOn(true);
    for (const m of this.props.machines) m.setPowered(true);
    this.props.pack.setPowered(true);
    audio.doorOpen();
    audio.buy();
    this.hud.banner('POWER RESTORED', 2.4, '#7affd0');
    this.retro.setTint(0x7affd0, 0.4);
  }

  private packWeapon(): void {
    const slot = this.player.slot;
    if (slot.packed) {
      audio.deny();
      return;
    }
    if (!this.player.spend(PACK_COST)) {
      audio.deny();
      return;
    }
    const def = getWeapon(slot.id);
    slot.packed = true;
    slot.mag = def.magSize;
    slot.reserve = def.reserveMax;
    this.equipCurrent();
    this.viewmodel.setPose('raise', 0.4);
    this.props.pack.showWeapon(slot.id);
    window.setTimeout(() => this.props.pack.showWeapon(null), 1800);
    audio.perkJingle();
    this.syncAmmoHud();
    this.finishPurchase(PACK_COST, packedName(def.name), false);
  }

  private rollBox(): void {
    if (!this.player.spend(MYSTERY_BOX_COST)) {
      audio.deny();
      return;
    }
    this.boxState = 'rolling';
    this.boxTimer = 3.4;
    this.boxBuyer = true;
    this.boxRolls++;
    audio.boxJingle();
    this.box.setLid(1);
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(-MYSTERY_BOX_COST);
  }

  private takeBoxWeapon(): void {
    if (!this.boxOffer) return;
    const id = this.boxOffer;
    this.player.giveWeapon(id);
    this.equipCurrent();
    this.viewmodel.setPose('raise', 0.32);
    this.syncAmmoHud();
    audio.buy();
    this.hud.toast(getWeapon(id).name, '#ffc84d', 2);
    this.boxOffer = null;
    this.boxState = 'closing';
    this.boxTimer = 0.5;
    this.box.showWeapon(null);
  }

  private finishPurchase(cost: number, label: string, jingle = true): void {
    if (jingle) audio.buy();
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(-cost);
    this.hud.toast(label, '#ffc84d', 1.6);
  }

  private syncAmmoHud(): void {
    const s = this.player.slot;
    const def = getWeapon(s.id);
    this.hud.setWeapon(
      s.packed ? packedName(def.name) : def.name, s.mag, s.reserve, def.magSize,
    );
  }

  /* ---------------------------------------------------------------- frame */

  update(dt: number): void {
    this.elapsed += dt;
    this.hud.update(dt);

    if (this.state !== 'playing') {
      this.input.endFrame();
      return;
    }

    this.runSeconds += dt;
    this.handleLook(dt);
    this.handleActions();
    this.updatePlayer(dt);
    this.updateRound(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateDrops(dt);
    this.updateBox(dt);
    this.updateProps(dt);
    this.updateEffects(dt);
    this.updateCamera(dt);
    this.updateHud(dt);
    this.input.endFrame();
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    p.tickHealth(dt);
    p.tickWeapons(dt, (e) => {
      if (e === 'shell') {
        // Another shell if the tube is not full yet, otherwise pump one in.
        if (p.reloading) this.viewmodel.setPose('reload', p.reloadRemaining);
        else this.viewmodel.setPose('shellEnd', 0.5);
      } else if (e === 'swapped') {
        this.equipCurrent();
        this.viewmodel.setPose('raise', 0.3);
        this.syncAmmoHud();
      } else if (e === 'melee-hit') {
        this.doMelee();
      }
    });

    const fwd = (this.input.isDown('forward') ? 1 : 0) - (this.input.isDown('back') ? 1 : 0);
    const str = (this.input.isDown('right') ? 1 : 0) - (this.input.isDown('left') ? 1 : 0);
    const move = p.updateMovement(dt, this.grid, {
      forward: fwd,
      strafe: str,
      sprint: this.input.isDown('sprint'),
      jump: this.input.isDown('jump'),
    });

    if (move.landed) audio.footstep();
    if (p.grounded && p.planarSpeed > 0.5) {
      this.stepTimer -= dt * p.planarSpeed;
      if (this.stepTimer <= 0) {
        this.stepTimer = 4.6;
        audio.footstep();
      }
      this.bobPhase += dt * p.planarSpeed * 1.35;
    }

    // Interaction: tap to buy, hold to reboard.
    const target = this.findInteractable();
    if (target) {
      const costText = target.cost > 0 ? ` <b>[${target.cost}]</b>` : '';
      this.hud.setPrompt(`<b>F</b> ${target.label}${costText}`, target.affordable);
      const b = target.repair;
      if (b) {
        if (this.input.isDown('use')) {
          this.repairHold += dt;
          if (this.repairHold >= 0.42) {
            this.repairHold = 0;
            if (b.addBoard()) {
              this.torn.delete(this.grid.idx(b.def.tx, b.def.tz));
              this.grid.invalidateField();
              const award = 10;
              p.award(award);
              this.hud.pointsDelta(award);
              this.hud.setPoints(p.points);
              audio.boardBreak({ x: b.center.x, z: b.center.z });
            }
          }
        } else {
          this.repairHold = 0;
        }
      } else if (this.input.consume('use')) {
        target.act();
      }
    } else {
      this.hud.setPrompt(null);
      this.repairHold = 0;
      this.input.consume('use');
    }
  }

  private doMelee(): void {
    const def = getWeapon('knife');
    this.camera.getWorldDirection(this.tmpDir);
    const ox = this.camera.position.x;
    const oz = this.camera.position.z;
    const best: { e: Enemy | null; d: number } = { e: null, d: Infinity };
    this.pool.forEachLive((e) => {
      const dx = e.x - ox;
      const dz = e.z - oz;
      const d = Math.hypot(dx, dz);
      if (d > def.range + e.radius) return;
      const dot = d > 0.01 ? (dx / d) * this.tmpDir.x + (dz / d) * this.tmpDir.z : 1;
      if (dot < 0.55) return;
      if (d < best.d) {
        best.e = e;
        best.d = d;
      }
    });
    const target = best.e;
    if (!target) return;
    const dmg = this.activePowerups.has('instakill') ? 1e6 : def.damage;
    const killedBefore = target.health;
    this.damageEnemy(target, dmg, false, false, new THREE.Vector3(target.x, target.headY, target.z));
    if (killedBefore <= dmg) {
      // Melee kills pay the premium rate.
      const extra = scoreForKill('melee', this.activePowerups.has('doublepoints'))
        - scoreForKill('body', this.activePowerups.has('doublepoints'));
      this.player.award(extra);
      this.hud.setPoints(this.player.points);
    }
  }

  private updateRound(dt: number): void {
    if (this.roundPhase === 'clear') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.startRound(this.round + 1);
      return;
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.plan.interval;
      this.trySpawn();
    }

    if (this.spawned >= this.plan.total && this.pool.liveCount === 0) this.endRound();

    for (const [id, remaining] of [...this.activePowerups]) {
      const next = remaining - dt;
      if (next <= 0) this.activePowerups.delete(id);
      else this.activePowerups.set(id, next);
    }
  }

  private updateEnemies(dt: number): void {
    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {
      this.fieldTimer = 0.14;
      const { tx, tz } = worldToTile(this.player.x, this.player.z);
      this.grid.buildFlowField(tx, tz, this.torn);
    }

    for (const e of this.pool.all) {
      if (!e.active) continue;
      e.update(
        dt, this.grid, this.player.x, this.player.z, this.player.alive, this.torn,
        (enemy, dmg) => {
          this.hurtPlayer(dmg);
          if (enemy.kind === 'hound') audio.bark({ x: enemy.x, z: enemy.z });
          else if (this.rng.chance(0.7)) audio.zombieVoice({ x: enemy.x, z: enemy.z }, 'snarl', this.voicePitch(enemy));
        },
        (_enemy, b) => {
          audio.boardBreak({ x: b.center.x, z: b.center.z });
          for (let i = 0; i < 6; i++) {
            this.particles.spawn(
              b.center.x, b.center.y, b.center.z,
              this.rng.range(-5, 5), this.rng.range(1, 7), this.rng.range(-5, 5),
              DUST_COLOR, this.rng.range(0.3, 0.8), 24,
            );
          }
          if (b.isOpen) {
            this.torn.add(this.grid.idx(b.def.tx, b.def.tz));
            this.grid.invalidateField();
          }
        },
        (enemy) => {
          if (enemy.kind === 'hound') audio.bark({ x: enemy.x, z: enemy.z });
          else this.zombieSpeaks(enemy);
        },
      );
    }

    this.pool.resolveCrowding(this.grid, this.torn);

    // A body lost far away out of sight goes back in the queue and comes in
    // through a window nearer the player, so the horde never loses the scent.
    for (const e of this.pool.all) {
      if (!e.active || !e.lost) continue;
      e.retire();
      this.spawned = Math.max(0, this.spawned - 1);
    }

    const probe = this.level.probe;
    for (const e of this.pool.all) {
      if (!e.active) continue;
      probe.sample(e.x, e.z, this.tmpLight);
      // Freshly shot bodies flash, which reads as a hit even at a distance.
      if (e.hitFlash > 0) this.tmpLight.addScalar(e.hitFlash * 1.6);
      applyLight(e.model, this.tmpLight);
    }
  }

  /** Deeper for brutes, higher for runners, and never quite the same twice. */
  private voicePitch(e: Enemy): number {
    const base = e.kind === 'brute' ? 0.72 : e.kind === 'runner' ? 1.18 : 1;
    return base * this.rng.range(0.9, 1.1);
  }

  /** Idle vocalising: a long moan from afar, a growl once it has your scent. */
  private zombieSpeaks(e: Enemy): void {
    const d = Math.hypot(e.x - this.player.x, e.z - this.player.z);
    const hunting = e.state === 'hunt' || e.state === 'attack';
    let kind: ZombieVoice = 'moan';
    if (e.kind === 'runner' && this.rng.chance(0.3)) kind = 'scream';
    else if (hunting && d < 16 && this.rng.chance(0.55)) kind = 'growl';
    audio.zombieVoice({ x: e.x, z: e.z }, kind, this.voicePitch(e));
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p.alive) continue;

      p.vy -= p.gravity * dt;
      const nx = p.mesh.position.x + p.vx * dt;
      const ny = p.mesh.position.y + p.vy * dt;
      const nz = p.mesh.position.z + p.vz * dt;
      p.fuse -= dt;

      let detonate = p.fuse <= 0;
      let hx = nx;
      let hy = ny;
      let hz = nz;

      const step = Math.hypot(nx - p.mesh.position.x, nz - p.mesh.position.z);
      if (step > 0.001) {
        const hit = this.grid.raycast(
          p.mesh.position.x, p.mesh.position.z,
          (nx - p.mesh.position.x) / step, (nz - p.mesh.position.z) / step,
          step, this.torn,
        );
        if (hit.hit) {
          if (p.kind === 'grenade') {
            // Grenades bounce off walls instead of blowing up on contact.
            if (hit.nx !== 0) p.vx = -p.vx * 0.45;
            if (hit.nz !== 0) p.vz = -p.vz * 0.45;
          } else {
            detonate = true;
            hx = hit.x;
            hz = hit.z;
            hy = ny;
          }
        }
      }
      if (ny <= 0.25) {
        if (p.kind === 'grenade') {
          p.vy = Math.abs(p.vy) * 0.35;
          p.vx *= 0.7;
          p.vz *= 0.7;
        } else {
          detonate = true;
          hy = 0.25;
        }
      }
      if (ny >= WALL_H - 0.3 && p.kind !== 'grenade') {
        detonate = true;
        hy = WALL_H - 0.3;
      }

      if (!detonate && p.direct > 0) {
        this.pool.forEachLive((e) => {
          if (detonate) return;
          const d = Math.hypot(e.x - nx, e.z - nz);
          if (d < e.radius + 0.5 && ny > e.y && ny < e.bodyTop) {
            detonate = true;
            hx = nx;
            hy = ny;
            hz = nz;
            this.damageEnemy(e, p.direct, false, true, new THREE.Vector3(e.x, e.headY, e.z));
          }
        });
      }

      p.mesh.position.set(
        Math.max(0.2, nx), Math.max(0.2, Math.min(WALL_H - 0.2, ny)), Math.max(0.2, nz),
      );
      if (p.kind !== 'grenade') p.mesh.lookAt(nx + p.vx, ny + p.vy, nz + p.vz);
      else p.mesh.rotation.x += dt * 9;

      if (detonate) {
        this.explode(hx, hy, hz, p.radius, p.damage);
        this.scene.remove(p.mesh);
        p.alive = false;
        this.projectiles.splice(i, 1);
      }
    }
  }

  private updateDrops(dt: number): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      d.group.rotation.y += dt * 2.2;
      d.group.position.y = 1.4 + Math.sin(this.elapsed * 3 + i) * 0.22;
      // Blink out over the last four seconds.
      d.group.visible = d.life > 4 || Math.floor(d.life * 6) % 2 === 0;

      const dist = Math.hypot(d.x - this.player.x, d.z - this.player.z);
      if (dist < 3.2 && this.player.alive) {
        this.applyPowerUp(d.id);
        this.scene.remove(d.group);
        this.drops.splice(i, 1);
        continue;
      }
      if (d.life <= 0) {
        this.scene.remove(d.group);
        this.drops.splice(i, 1);
      }
    }
  }

  private updateBox(dt: number): void {
    const box = this.box;
    box.animate(this.elapsed, this.elapsed * 6);

    if (this.boxState === 'rolling') {
      this.boxTimer -= dt;
      // Cycle visible weapons quickly, slowing toward the reveal.
      const tick = Math.max(0.06, 0.34 - this.boxTimer * 0.08);
      if (Math.floor(this.boxTimer / tick) !== Math.floor((this.boxTimer + dt) / tick)) {
        box.showWeapon(BOX_POOL[this.rng.int(BOX_POOL.length)]);
      }
      if (this.boxTimer <= 0) {
        this.boxOffer = BOX_POOL[this.rng.weighted(boxWeights())];
        box.showWeapon(this.boxOffer);
        this.boxState = 'offer';
        this.boxTimer = 9;
        audio.buy();
      }
      return;
    }

    if (this.boxState === 'offer') {
      this.boxTimer -= dt;
      if (this.boxTimer <= 0) {
        this.boxOffer = null;
        box.showWeapon(null);
        this.boxState = 'closing';
        this.boxTimer = 0.5;
      }
      return;
    }

    if (this.boxState === 'closing') {
      this.boxTimer -= dt;
      box.setLid(Math.max(0, this.boxTimer / 0.5));
      if (this.boxTimer <= 0) {
        box.setLid(0);
        this.boxBuyer = false;
        if (this.boxRolls >= this.boxLimit) {
          this.boxState = 'moving';
          this.boxTimer = 1.4;
          this.hud.toast('THE BOX HAS MOVED', '#ffc84d', 2.4);
        } else {
          this.boxState = 'idle';
        }
      }
      return;
    }

    if (this.boxState === 'moving') {
      this.boxTimer -= dt;
      if (this.boxTimer <= 0) {
        const pads = this.layout.boxPads;
        const open = pads.map((p, i) => ({ p, i })).filter(
          (e) => this.openZones.has(e.p.zone) && e.i !== box.padIndex,
        );
        const pick = open.length ? open[this.rng.int(open.length)] : { p: pads[0], i: 0 };
        box.moveTo(pick.p, pick.i, this.level.probe);
        this.boxRolls = 0;
        this.boxLimit = this.rng.int(BOX_MOVE_MAX - BOX_MOVE_MIN + 1) + BOX_MOVE_MIN;
        this.boxState = 'idle';
      }
    }
  }

  private updateProps(dt: number): void {
    for (const d of this.props.doors) d.update(dt);
    this.level.update(this.elapsed);
    for (const m of this.props.machines) m.animate(this.elapsed);
    for (const w of this.props.wallBuys) w.animate(this.elapsed);
    this.props.pack.animate(this.elapsed);
  }

  private updateEffects(dt: number): void {
    this.particles.update(dt);

    for (let i = 0; i < this.tracers.length; i++) {
      if (this.tracerLife[i] <= 0) continue;
      this.tracerLife[i] -= dt;
      const mat = this.tracers[i].material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, this.tracerLife[i] / 0.055);
      if (this.tracerLife[i] <= 0) this.tracers[i].visible = false;
    }

    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.9);
    this.retro.setDamage(this.damageFlash * 0.85);
    this.shake = Math.max(0, this.shake - dt * 6);

    if (this.fadeIn < 1) {
      this.fadeIn = Math.min(1, this.fadeIn + dt * 1.4);
      this.retro.setFade(this.fadeIn);
    }

    // Decay whatever tint the last event applied.
    const instaKill = this.activePowerups.has('instakill');
    const doublePoints = this.activePowerups.has('doublepoints');
    if (instaKill) this.retro.setTint(0xff4040, 0.16);
    else if (doublePoints) this.retro.setTint(0x40b0ff, 0.12);
    else this.retro.setTint(0x000000, 0);
  }

  private updateCamera(dt: number): void {
    const p = this.player;
    const bobAmount = Math.min(1, p.planarSpeed / 9);
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.09 * bobAmount;
    const bobX = Math.sin(this.bobPhase * 0.5) * 0.06 * bobAmount;

    const shakeX = this.shake > 0 ? this.rng.range(-1, 1) * this.shake * 0.035 : 0;
    const shakeY = this.shake > 0 ? this.rng.range(-1, 1) * this.shake * 0.035 : 0;

    this.camera.position.set(
      p.x + bobX * 0.3 + shakeX,
      p.y + EYE_HEIGHT + bobY + shakeY,
      p.z,
    );
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(p.yaw);
    this.camera.rotateX(p.pitch);
    this.camera.rotateZ(Math.sin(this.bobPhase * 0.5) * 0.012 * bobAmount + shakeX * 0.4);

    const scoped = this.viewmodel.scopeView;
    const targetFov = this.fovBase * (scoped ? 0.3 : this.input.aim ? 0.72 : 1) * (p.sprinting ? 1.045 : 1);
    this.hud.setScope(scoped);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 11);
    this.camera.updateProjectionMatrix();

    this.torch.position.copy(this.camera.position);
    this.torch.intensity = 9 + Math.sin(this.elapsed * 9) * 0.5;

    // Fog colour eases toward whichever room the player is standing in.
    const { tx, tz } = worldToTile(p.x, p.z);
    this.fogTarget.copy(fogColorAt(this.layout, zoneAt(this.layout, tx, tz)));
    this.fog.color.lerp(this.fogTarget, Math.min(1, dt * 1.6));
    (this.scene.background as THREE.Color).copy(this.fog.color);

    audio.setListener({ x: p.x, z: p.z }, p.yaw);
    audio.updateMusic(dt, Math.min(1, this.round / 14 + this.pool.liveCount / 24));

    this.level.probe.sample(p.x, p.z, this.tmpLight);
    this.viewmodel.update(dt, {
      speed: p.planarSpeed,
      grounded: p.grounded,
      aiming: this.input.aim,
      sprinting: p.sprinting,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      lowHealth: p.healthFraction < 0.35,
      mag: p.slot.mag,
      light: this.tmpLight,
    });
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      this.viewmodel.muzzleWorld(this.camera, this.muzzleLight.position);
      this.muzzleLight.intensity = Math.max(0, this.muzzleLightTimer / 0.06) * 60;
    } else {
      this.muzzleLight.intensity = 0;
    }
    this.lookDX *= 0.82;
    this.lookDY *= 0.82;
  }

  private updateHud(_dt: number): void {
    const p = this.player;
    this.hud.setHealth(p.healthFraction);
    this.hud.setStamina(p.stamina);
    this.hud.setCrosshair(!this.input.aim);
    this.hud.setPowerupTimers(
      [...this.activePowerups].map(([id, sec]) => ({
        name: POWERUPS[id].name,
        color: `#${POWERUPS[id].color.toString(16).padStart(6, '0')}`,
        seconds: sec,
      })),
    );
    this.syncAmmoHud();

    if (this.hud.mapVisible) {
      const blips: MinimapBlip[] = [];
      this.pool.forEachLive((e) =>
        blips.push({ x: e.x, z: e.z, color: e.kind === 'hound' ? '#ff6a2a' : '#d22f26' }),
      );
      blips.push({ x: this.box.center.x, z: this.box.center.z, color: '#ffc84d' });
      for (const m of this.props.machines) {
        if (!m.powered) continue;
        blips.push({
          x: m.center.x, z: m.center.z,
          color: `#${PERK_INFO[m.id].color.toString(16).padStart(6, '0')}`,
        });
      }
      for (const d of this.drops) {
        blips.push({
          x: d.x, z: d.z,
          color: `#${POWERUPS[d.id].color.toString(16).padStart(6, '0')}`, size: 1.6,
        });
      }
      this.hud.drawMinimap(this.grid.tiles, p.x, p.z, p.yaw, blips);
    }
  }

  render(): void {
    this.retro.render(this.scene, this.camera, this.elapsed, {
      scene: this.viewmodel.scene,
      camera: this.viewmodel.camera,
    });
  }

  /** Name of the room the player is standing in, for the pause screen. */
  get currentZoneName(): string {
    const { tx, tz } = worldToTile(this.player.x, this.player.z);
    const z = zoneAt(this.layout, tx, tz);
    return z ? getZone(this.layout, z).name : 'CORRIDOR';
  }
}
