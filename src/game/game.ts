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
import { buildLevel, lookAt, type BuiltLevel } from '../world/build.ts';
import { dressLevel } from '../world/dressing.ts';
import { MAPS } from '../world/maps.ts';
import {
  MAP_W,
  TILE,
  T_FLOOR,
  WALL_H,
  type Layout,
  type MapId,
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
  CARPENTER_SCORE,
  DROPS_PER_ROUND,
  DROP_CHANCE,
  DROP_MIN_GAP,
  MYSTERY_BOX_COST,
  NUKE_SCORE,
  PERK_INFO,
  enemyHealth,
  houndHealth,
  POWERUPS,
  POWERUP_IDS,
  POWERUP_LIFETIME,
  SCORE_REPAIR,
  planRound,
  roundBonus,
  scoreForHit,
  scoreForKill,
  type EnemyKind,
  type PowerUpId,
  type SpawnPlan,
} from './rules.ts';
import { ViewModel } from './viewmodel.ts';
import {
  AMMO_MODS,
  AMMO_MOD_IDS,
  PAP_MAX,
  RARITY_INFO,
  getWeapon,
  magFor,
  modChance,
  papCost,
  papMultiplier,
  reserveFor,
  shotDamage,
  tierName,
  type AmmoMod,
  type WeaponDef,
} from './weapons.ts';
import { BoxController, type BoxUnit } from './box.ts';
import { BossEnemy, bossHealth, type BossHooks, type BossMove } from './boss.ts';
import { BOSS_DELAY, Quest } from './quest.ts';
import { RADIO_NAME, STATION_RADIUS, type BossId, type StoryBeat } from './story.ts';
import {
  buildQuestProps,
  disposeQuestProps,
  questGroups,
  type QuestProps,
} from '../world/questprops.ts';
import { ElementFX, FIRE_COLORS, ICE_COLORS, SPARK_BLUE } from './elements.ts';
import { EnemyTags } from './tags.ts';

/** Hex colour as a CSS string. */
function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

const ICE_TINT = new THREE.Color(0.7, 1.3, 2.2);
const FIRE_TINT = new THREE.Color(2.2, 1.0, 0.3);

export type GameState = 'boot' | 'menu' | 'playing' | 'paused' | 'gameover' | 'victory';

export type RunStats = {
  map: MapId;
  round: number;
  kills: number;
  headshots: number;
  points: number;
  seconds: number;
  /** Got out alive. */
  escaped: boolean;
};

/** Something a boss threw, in flight. */
type BossShot = {
  mesh: THREE.Mesh;
  kind: 'fireball' | 'acid';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
};

/** A patch of burning ground or acid that hurts to stand in. */
type Hazard = {
  mesh: THREE.Mesh;
  kind: 'fireball' | 'acid';
  x: number; z: number;
  radius: number;
  dps: number;
  life: number;
};

const SHOT_GRAVITY = 26;
const PART_SPARK = new THREE.Color(0.5, 2.4, 1.9);
/** What flies out of a zombie killed inside the ring of a hungry station. */
const SOUL_COLOR = new THREE.Color(2.6, 0.7, 0.25);
const ACID_COLOR = new THREE.Color(0.5, 1.8, 0.4);
/** How deep each boss roars. */
const BOSS_PITCH: Record<BossId, number> = { warden: 0.5, butcher: 0.42, furnace: 0.36, patient0: 0.62 };
/** Points for putting a boss down, on top of the kill. */
const BOSS_BOUNTY = 2500;

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
/** Fog start and end indoors, and out under the open sky where you can see further. */
const FOG_INDOOR: [number, number] = [16, 120];
const FOG_OUTDOOR: [number, number] = [26, 175];

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
  private questProps!: QuestProps;
  /** The goal of the current run. */
  quest: Quest = new Quest('asylum');
  /** Bosses are built once and kept. */
  private readonly bosses = new Map<BossId, BossEnemy>();
  private readonly bossHooks: BossHooks;
  /** The boss's own light, kept in the scene at zero so adding it never recompiles a shader. */
  private readonly bossLight = new THREE.PointLight(0xffffff, 0, 20, 2);
  private readonly bossShots: BossShot[] = [];
  private readonly hazards: Hazard[] = [];
  private hazardHurt = 0;
  /** Radio lines waiting for their moment, by run time. */
  private readonly radioQueue: { at: number; text: string }[] = [];
  private readonly tmpTarget = new THREE.Vector3();
  private readonly boxes: BoxController;
  private readonly elements = new ElementFX();
  /** How many mystery boxes this map runs at once. */
  private boxCount = 1;
  /** Ammo mods cannot go off on every round. */
  private modCooldown = 0;
  /** True while the world built at boot has not been played yet. */
  private worldFresh = false;
  private readonly pool = new EnemyPool();
  /** Health bars and damage numbers over the horde. */
  readonly tags: EnemyTags;
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
  onVictory: (stats: RunStats) => void = () => {};

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

  /**
   * True when the host frame loop calls `present()` itself, once per drawn
   * frame. Anything that drives `update()` on its own - the headless smoke
   * test - leaves this false and gets the HUD refreshed on every step.
   */
  hostPresents = false;

  private repairHold = 0;
  private legendaryFlash = 0;
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

    this.boxes = new BoxController(this.scene, 2, this.rng, {
      owned: () => this.player.slots.map((s) => s.id),
      openZones: () => this.openZones,
      probe: () => this.level.probe,
      onReveal: (u, id) => this.onBoxReveal(u, id),
      onBear: (u) => this.onBoxBear(u),
      onMoved: () => {},
    });
    this.scene.add(this.elements.group);
    this.scene.add(this.pool.group);
    const tagRoot = document.getElementById('tags');
    if (!tagRoot) throw new Error('missing HUD element #tags');
    this.tags = new EnemyTags(tagRoot, this.pool.all);
    this.scene.add(this.particles.points);

    // A dim lantern glow around the player, just enough to read a face at arm's length.
    this.torch = new THREE.PointLight(0xffd2a0, 9, 16, 2);
    this.scene.add(this.torch);
    this.scene.add(this.muzzleLight);
    this.scene.add(this.bossLight);
    this.bossHooks = this.makeBossHooks();
    this.viewmodel.init(this.retro.renderer);
    this.viewmodel.onEvent = (e) => audio.mech(e);

    this.buildTracerPool();
    this.buildDecalPool();
    this.buildWorld(randomSeed(), 'asylum');
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

  /** Throws away the current map and builds a new one from a seed. */
  private buildWorld(seed: number, map: MapId): void {
    if (this.level) {
      this.scene.remove(this.level.group);
      this.level.dispose();
      for (const g of propGroups(this.props)) this.scene.remove(g);
      disposeProps(this.props);
      for (const g of questGroups(this.questProps)) this.scene.remove(g);
      disposeQuestProps(this.questProps);
    }
    const profile = MAPS[map];
    this.layout = generateLayout(seed, profile);
    this.boxCount = profile.boxes;
    this.grid = new NavGrid(this.layout.tiles);
    this.level = buildLevel(this.layout, dressLevel(this.layout));
    this.scene.add(this.level.group);
    this.props = buildProps(this.layout, this.level.probe);
    for (const g of propGroups(this.props)) this.scene.add(g);
    // The chapter decides how many parts and valves go out into the map.
    const needs = new Quest(map);
    this.questProps = buildQuestProps(this.layout.parts, this.layout.spots, this.layout.workbench, this.layout.exit, {
      parts: needs.parts.length,
      valves: needs.valves.length,
      radius: STATION_RADIUS,
      seen: (x0, z0, x1, z1) => this.grid.lineOfSight(x0, z0, x1, z1),
    }, this.level.probe);
    for (const g of questGroups(this.questProps)) this.scene.add(g);
    this.boxes.reset(this.layout.boxPads, this.boxCount);
    const look = lookAt(this.layout, this.layout.spawnZone);
    this.fog.color.set(look.fog);
    this.fog.near = look.outdoor ? FOG_OUTDOOR[0] : FOG_INDOOR[0];
    this.fog.far = look.outdoor ? FOG_OUTDOOR[1] : FOG_INDOOR[1];
  }

  /** Which map is loaded. */
  get mapId(): MapId {
    return this.layout.map;
  }

  /** The seed of the map currently loaded. */
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
   * Starts a run on a map. Every run gets a freshly generated layout; pass a
   * seed to replay a particular one.
   */
  newRun(seed?: number, map: MapId = this.layout.map): void {
    if (seed !== undefined || !this.worldFresh || map !== this.layout.map) this.buildWorld(seed ?? randomSeed(), map);
    this.worldFresh = false;

    const spawn = tileCenter(this.layout.spawn.tx, this.layout.spawn.tz);
    this.player.reset(spawn.x, spawn.z);
    this.player.yaw = this.layout.spawn.yaw;
    this.player.pitch = 0;

    this.pool.reset();
    this.tags.clear();
    this.clearBossEffects();
    this.quest = new Quest(this.layout.map);
    this.syncQuestProps();
    this.radioQueue.length = 0;
    this.hud.clearRadio();
    this.hud.setBoss(null);
    this.torn.clear();
    this.openZones.clear();
    this.openZone(this.layout.spawnZone);
    this.activePowerups.clear();
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const d of this.drops) this.scene.remove(d.group);
    this.projectiles.length = 0;
    this.drops.length = 0;
    this.killsSinceDrop = 0;
    this.dropsThisRound = 0;
    this.runSeconds = 0;
    this.boxes.reset(this.layout.boxPads, this.boxCount);
    this.elements.reset();
    this.modCooldown = 0;
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
    this.hud.clearDamage();
    this.hud.setPoints(this.player.points);
    this.hud.setRound(1);
    this.hud.toggleMap(false);
    this.hud.setPerks([]);
    this.hud.setGrenades(this.player.grenades, this.player.hasGrenades);
    this.syncAmmoHud();

    this.setState('playing');
    audio.startMusic();
    const chapter = this.quest.chapter;
    this.hud.banner(this.layout.mapName, 2.6, '#e8e2ce');
    this.hud.toast(`CHAPTER ${chapter.number}: ${chapter.title}  ·  LAYOUT #${this.layout.seed}`, '#bdb6a0', 3.2);
    this.sayLater('start', 3.2);
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
      map: this.layout.map,
      escaped: this.quest.escaped,
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
    this.plan = planRound(n, this.quest.threat);
    this.spawned = 0;
    this.killedThisRound = 0;
    this.dropsThisRound = 0;
    this.spawnTimer = this.plan.isHoundRound ? 4.5 : 2.6;
    this.roundPhase = 'active';
    this.hud.setRound(n);
    audio.roundStart(n);
    audio.musicCue('fight');
    if (this.plan.isHoundRound) {
      audio.announce('hounds', 0.6);
      this.hud.banner('HELLHOUNDS', 2.6, '#ff6a2a');
      this.hud.toast('THEY COME IN PACKS', '#ff6a2a', 2.6);
    } else {
      this.hud.banner(`ROUND ${n}`, 2.0);
      audio.callout('roundStart', 1.5);
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
    audio.musicCue('calm');
    audio.callout('roundClear', 1.2);
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
      // Near windows are far likelier. Distant ones never drop to zero, but
      // on a big map the far side of it barely gets a look in.
      weights.push(d < 110 ? 1 / (1 + d * 0.05) + 0.06 : 0.012);
    }
    if (!candidates.length) return null;
    return candidates[this.rng.weighted(weights)];
  }

  private pickKind(): EnemyKind {
    const mix = this.plan.mix;
    return mix[this.rng.weighted(mix.map((m) => m.weight))].kind;
  }

  private trySpawn(): void {
    // Defending the station, they keep coming past the round's count.
    if (this.spawned >= this.plan.total && !this.quest.defending) return;
    // A boss fight thins the horde out so the fight is about the boss.
    const cap = this.bossAlive ? Math.ceil(this.plan.maxAlive * 0.4) + 1 : this.plan.maxAlive;
    if (this.pool.liveCount >= cap) return;
    const barricade = this.pickSpawnBarricade();
    if (!barricade) return;
    const kind = this.pickKind();
    const enemy = this.pool.acquire(kind);
    if (!enemy) return;

    const outside = {
      x: barricade.center.x + barricade.def.dx * TILE * 2.0,
      z: barricade.center.z + barricade.def.dz * TILE * 2.0,
    };
    enemy.spawn(kind, outside.x, outside.z, this.plan.health, this.round, barricade, this.rng, this.quest.threat);
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
      audio.callout('grenade', 0.1);
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
    audio.callout('reload');
    return true;
  }

  /** Puts the weapon in the active slot into the player's hands. */
  private equipCurrent(): void {
    this.viewmodel.equip(this.player.slot.id, this.player.slot.tier);
  }

  /* ---------------------------------------------------------------- combat */

  private attemptFire(): void {
    const outcome = this.player.tryFire();
    if (outcome.kind === 'none') return;
    if (outcome.kind === 'dry') {
      audio.dryFire();
      if (this.player.slot.reserve > 0) this.startReload();
      else audio.callout('empty', 0.15);
      return;
    }
    if (outcome.kind !== 'shoot') return;

    const def = outcome.def;
    const tier = this.player.slot.tier;
    // Firing out of a shell-by-shell reload abandons it.
    if (def.shellReload) this.viewmodel.cancelShells();
    this.viewmodel.kick(def.kick * (this.input.aim ? 0.6 : 1));
    this.muzzleLightTimer = 0.06;
    this.muzzleLight.color.setHex(def.tracer || 0xffc070);
    this.shake = Math.min(3.2, this.shake + def.shake * 0.35);
    if (def.kind === 'flame') audio.flameTick();
    else audio.shot(def, { x: this.player.x, z: this.player.z });
    this.syncAmmoHud();

    const origin = this.tmpV.set(this.camera.position.x, this.camera.position.y, this.camera.position.z).clone();
    this.camera.getWorldDirection(this.tmpDir);
    const base = this.tmpDir.clone();

    if (def.kind === 'rocket' || def.kind === 'plasma') {
      this.spawnProjectile(def, origin, base, tier);
      return;
    }
    if (def.kind === 'cone') {
      this.coneBlast(origin, base, def, tier);
      return;
    }
    if (def.kind === 'chain') {
      this.stormBolt(origin, base, def, tier);
      return;
    }
    if (def.kind === 'frost') {
      this.frostCone(origin, base, def, tier);
      return;
    }
    if (def.kind === 'flame') {
      this.flameStream(origin, base, def, tier);
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
      this.hitscan(origin, dir, def, tier, i === 0);
    }
  }

  private hitscan(
    origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, tier: number, tracer: boolean,
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
        // Insta-kill does not one-shot a boss.
        instaKill: this.activePowerups.has('instakill') && !struck.isBoss,
        tier,
      });
      this.damageEnemy(struck, dmg, best.head, false, hitPoint);
      this.maybeTriggerMod(struck, hitPoint);
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
  private coneBlast(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, tier: number): void {
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
        e, shotDamage(def, { head: false, doubleTap: false, instaKill: false, tier }) * (e.isBoss ? 0.15 : 1),
        false, true, new THREE.Vector3(e.x, e.headY, e.z),
      );
    }
    this.shake = 4;
  }

  /* ------------------------------------------------------------- elements */

  /** Stormcaller: a bolt to the first body in the sights, then on through the crowd. */
  private stormBolt(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, tier: number): void {
    const muzzle = this.viewmodel.muzzleWorld(this.camera, new THREE.Vector3());
    const wall = this.grid.raycast(origin.x, origin.z, dir.x, dir.z, def.range, this.torn);
    const limit = wall.hit ? wall.dist / Math.max(0.0001, Math.hypot(dir.x, dir.z)) : def.range;
    // Lightning is forgiving: take the body closest to the aim line.
    let first: Enemy | null = null;
    let bestScore = Infinity;
    this.pool.forEachLive((e) => {
      const dx = e.x - origin.x;
      const dz = e.z - origin.z;
      const along = dx * dir.x + dz * dir.z;
      if (along <= 0 || along > limit) return;
      const off = Math.hypot(dx - dir.x * along, dz - dir.z * along);
      if (off > 2.2 + along * 0.05) return;
      if (!this.grid.lineOfSight(origin.x, origin.z, e.x, e.z)) return;
      const score = off * 3 + along * 0.1;
      if (score < bestScore) {
        bestScore = score;
        first = e;
      }
    });
    const target = first as Enemy | null;
    if (!target) {
      const end = new THREE.Vector3().copy(dir).multiplyScalar(Math.min(limit, 30)).add(origin);
      this.elements.bolt(muzzle, end, def.tracer);
      audio.zap();
      return;
    }
    const dmg = shotDamage(def, { head: false, doubleTap: false, instaKill: false, tier });
    this.chainLightning(target, muzzle, dmg, def.splashDamage + tier * 2, def.splashRadius, def.tracer);
  }

  /** Lightning into one body, then jumping on to the nearest others that can see it. */
  private chainLightning(first: Enemy, from: THREE.Vector3, damage: number, jumps: number, radius: number, color: number): void {
    const hit = new Set<Enemy>();
    let cur: Enemy | null = first;
    const prev = from.clone();
    for (let i = 0; i < jumps && cur; i++) {
      const e: Enemy = cur;
      hit.add(e);
      const at = new THREE.Vector3(e.x, e.y + e.model.height * 0.6, e.z);
      this.elements.bolt(prev, at, color);
      for (let k = 0; k < 6; k++) {
        this.particles.spawn(at.x, at.y, at.z, this.rng.range(-5, 5), this.rng.range(1, 7), this.rng.range(-5, 5),
          SPARK_BLUE, this.rng.range(0.15, 0.4), 16);
      }
      e.shocked = Math.max(e.shocked, e.isBoss ? 0.12 : 0.7);
      this.damageEnemy(e, e.isBoss ? damage * 0.2 : damage, false, false, at, { x: prev.x, z: prev.z });
      let next: Enemy | null = null;
      let bestD = radius;
      this.pool.forEachLive((o) => {
        if (hit.has(o)) return;
        const d = Math.hypot(o.x - e.x, o.z - e.z);
        if (d < bestD && this.grid.lineOfSight(e.x, e.z, o.x, o.z)) {
          bestD = d;
          next = o;
        }
      });
      prev.copy(at);
      cur = next;
    }
    audio.zap({ x: first.x, z: first.z });
  }

  /** Winter's Howl: a cone of frost that freezes everything it touches. */
  private frostCone(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, tier: number): void {
    const muzzle = this.viewmodel.muzzleWorld(this.camera, new THREE.Vector3());
    for (let i = 0; i < 26; i++) {
      const s = this.rng.range(16, 26);
      const c = ICE_COLORS[i % ICE_COLORS.length];
      this.particles.spawn(muzzle.x, muzzle.y, muzzle.z,
        dir.x * s + this.rng.range(-4, 4), dir.y * s + this.rng.range(-2.5, 2.5), dir.z * s + this.rng.range(-4, 4),
        c, this.rng.range(0.35, 0.75), 2);
    }
    const dmg = shotDamage(def, { head: false, doubleTap: false, instaKill: false, tier });
    const hits: Enemy[] = [];
    this.pool.forEachLive((e) => {
      const dx = e.x - origin.x;
      const dz = e.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > def.range || d < 0.001) return;
      if ((dx / d) * dir.x + (dz / d) * dir.z < 0.8) return;
      if (!this.grid.lineOfSight(origin.x, origin.z, e.x, e.z)) return;
      hits.push(e);
    });
    for (const e of hits) this.freeze(e, 3.5 + tier * 0.5, dmg);
    audio.freeze({ x: this.player.x, z: this.player.z });
  }

  private freeze(e: Enemy, seconds: number, damage: number): void {
    const at = new THREE.Vector3(e.x, e.y + e.model.height * 0.5, e.z);
    this.damageEnemy(e, damage, false, false, at);
    if (e.state === 'dead') return;
    e.frozen = Math.max(e.frozen, e.isBoss ? 0.5 : seconds);
    e.burning = 0;
    for (let k = 0; k < 6; k++) {
      this.particles.spawn(at.x, at.y, at.z, this.rng.range(-3, 3), this.rng.range(0, 4), this.rng.range(-3, 3),
        ICE_COLORS[k % ICE_COLORS.length], this.rng.range(0.3, 0.7), 10);
    }
  }

  /** Dragonfire: one tick of the flame stream, stopped by the first wall. */
  private flameStream(origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, tier: number): void {
    const muzzle = this.viewmodel.muzzleWorld(this.camera, new THREE.Vector3());
    const wall = this.grid.raycast(origin.x, origin.z, dir.x, dir.z, def.range, this.torn);
    const reach = wall.hit ? Math.min(def.range, wall.dist / Math.max(0.0001, Math.hypot(dir.x, dir.z))) : def.range;
    for (let i = 0; i < 8; i++) {
      const s = this.rng.range(15, 22);
      this.particles.spawn(muzzle.x, muzzle.y, muzzle.z,
        dir.x * s + this.rng.range(-2.2, 2.2), dir.y * s + this.rng.range(-1, 2.2), dir.z * s + this.rng.range(-2.2, 2.2),
        FIRE_COLORS[i % FIRE_COLORS.length], (reach / s) * this.rng.range(0.6, 1), -4);
    }
    const dmg = shotDamage(def, { head: false, doubleTap: false, instaKill: false, tier });
    this.pool.forEachLive((e) => {
      const dx = e.x - origin.x;
      const dz = e.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + e.radius || d < 0.001) return;
      if ((dx / d) * dir.x + (dz / d) * dir.z < 0.86) return;
      if (!this.grid.lineOfSight(origin.x, origin.z, e.x, e.z)) return;
      this.damageEnemy(e, dmg * (e.fireproof ? 0.25 : 1), false, false, new THREE.Vector3(e.x, e.y + 2, e.z), this.player, { quiet: true });
      this.ignite(e, 4 + tier);
    });
  }

  private ignite(e: Enemy, seconds: number): void {
    if (e.state === 'dead' || e.fireproof) return;
    e.frozen = 0;
    e.burning = Math.max(e.burning, e.isBoss ? seconds * 0.5 : seconds);
    e.burnDps = Math.max(e.burnDps, 40 + e.maxHealth * (e.isBoss ? 0.004 : 0.09));
  }

  /** Tier II and III guns: sometimes a landed round sets off the gun's ammo mod. */
  private maybeTriggerMod(e: Enemy, at: THREE.Vector3): void {
    const slot = this.player.slot;
    if (!slot.mod || slot.tier < 2 || this.modCooldown > 0) return;
    const { chance, cooldown } = modChance(slot.tier);
    if (!this.rng.chance(chance)) return;
    this.modCooldown = cooldown;
    this.triggerMod(slot.mod, e, at, slot.tier);
  }

  private triggerMod(mod: AmmoMod, e: Enemy, at: THREE.Vector3, tier: number): void {
    const color = AMMO_MODS[mod].color;
    if (mod === 'deadwire') {
      const pct = e.isBoss ? 0.02 : tier >= 3 ? 0.45 : 0.3;
      this.chainLightning(e, at, 400 + e.maxHealth * pct, tier >= 3 ? 6 : 4, 9, color);
      return;
    }
    const radius = mod === 'blastfurnace' ? 6.5 : 5.5;
    const near: Enemy[] = [];
    this.pool.forEachLive((o) => {
      if (Math.hypot(o.x - e.x, o.z - e.z) <= radius) near.push(o);
    });
    if (e.state !== 'dead' && !near.includes(e)) near.push(e);
    if (mod === 'blastfurnace') {
      for (let k = 0; k < 30; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const s = this.rng.range(3, 9);
        this.particles.spawn(at.x, at.y, at.z, Math.cos(a) * s, this.rng.range(1, 6), Math.sin(a) * s,
          FIRE_COLORS[k % FIRE_COLORS.length], this.rng.range(0.3, 0.8), -3);
      }
      for (const o of near) this.ignite(o, 4 + tier);
      audio.fireBurst({ x: at.x, z: at.z });
    } else {
      for (let k = 0; k < 30; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const s = this.rng.range(2, 7);
        this.particles.spawn(at.x, at.y, at.z, Math.cos(a) * s, this.rng.range(0, 4), Math.sin(a) * s,
          ICE_COLORS[k % ICE_COLORS.length], this.rng.range(0.3, 0.8), 8);
      }
      for (const o of near) this.freeze(o, 3 + tier * 0.5, 0);
      audio.freeze({ x: at.x, z: at.z });
    }
  }

  private spawnProjectile(
    def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, tier: number,
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
    const mult = papMultiplier(tier);
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

    const killsBefore = this.player.kills;
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
    if (this.player.kills - killsBefore >= 3) audio.callout('multikill', 0.35);

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
    opts: { quiet?: boolean } = {},
  ): void {
    // Frozen bodies are brittle.
    if (e.frozen > 0) amount *= 1.5;
    let dirX = e.x - from.x;
    let dirZ = e.z - from.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    dirX /= len;
    dirZ /= len;
    const res = e.applyDamage(amount, head, explosive, dirX, dirZ);
    if (res.damageDealt <= 0) return;
    this.tags.hit(e, res.damageDealt, opts.quiet ? 'burn' : head ? 'head' : 'body', res.killed, at);

    const doublePoints = this.activePowerups.has('doublepoints');
    if (res.shattered) {
      // Frozen solid, it bursts into ice.
      for (let i = 0; i < 34; i++) {
        this.particles.spawn(e.x, e.y + this.rng.range(0.4, 3), e.z,
          this.rng.range(-7, 7), this.rng.range(1, 9), this.rng.range(-7, 7),
          ICE_COLORS[i % ICE_COLORS.length], this.rng.range(0.4, 1.1), 26);
      }
      audio.freeze({ x: e.x, z: e.z });
    }
    // Damage over time and flame ticks stay quiet: no spray, no hit points.
    if (opts.quiet && !res.killed) return;
    const gore = res.killed ? (res.gibbed && !res.shattered ? 26 : 14) : head ? 9 : 5;
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
    if (head && !explosive && !e.isBoss) audio.callout('headshot', 0.3);
    this.killedThisRound++;
    this.hud.pointsDelta(award);
    this.hud.hitmarker(true);
    this.hud.setPoints(this.player.points);
    if (e.isBoss) this.onBossKilled(e);
    else {
      this.maybeDropPowerUp(e.x, e.z);
      this.feedStation(e);
    }
  }

  /** A kill inside the ring while the station is hungry: its soul flies in. */
  private feedStation(e: Enemy): void {
    if (!this.quest.harvesting) return;
    const c = this.questProps.bench.center;
    if (Math.hypot(e.x - c.x, e.z - c.z) > STATION_RADIUS || !this.grid.lineOfSight(c.x, c.z, e.x, e.z)) return;
    // Straight at the station with no gravity, arriving just as they fade.
    const y = e.y + 2.2;
    for (let i = 0; i < 9; i++) {
      const life = this.rng.range(0.55, 0.8);
      this.particles.spawn(
        e.x + this.rng.range(-0.5, 0.5), y + this.rng.range(-0.6, 0.6), e.z + this.rng.range(-0.5, 0.5),
        (c.x - e.x) / life, (c.y + 0.8 - y) / life, (c.z - e.z) / life,
        SOUL_COLOR, life, 0,
      );
    }
    audio.soul({ x: e.x, z: e.z });
    this.beats(this.quest.harvest());
  }

  /**
   * Takes health off the player. `from` is where the hit came from, when there
   * is a direction worth pointing at - a swing, a shockwave, something thrown -
   * and puts a wedge on that side of the crosshair. It is left out for damage
   * that has no bearing: your own grenade, or ground you are standing in.
   */
  private hurtPlayer(amount: number, from?: { x: number; z: number }): void {
    if (amount <= 0 || !this.player.alive) return;
    const died = this.player.takeDamage(amount);
    this.damageFlash = Math.min(1, this.damageFlash + amount / 70);
    this.hud.damageFlash(from ? this.bearingTo(from) : null);
    this.hud.setHealth(this.player.healthFraction);
    audio.hurt(amount, this.player.healthFraction);
    if (!died && this.player.healthFraction < 0.35) audio.callout('hurt', 0.45);
    this.shake = Math.max(this.shake, 1.4);
    if (died) this.die();
  }

  /**
   * Which way a point lies from the player, in radians clockwise off the way
   * they are facing: 0 is dead ahead, +/-PI is behind. Same yaw convention as
   * the camera and the ears - yaw 0 looks down -z, +x is to the right.
   */
  private bearingTo(at: { x: number; z: number }): number {
    const dx = at.x - this.player.x;
    const dz = at.z - this.player.z;
    const s = Math.sin(this.player.yaw);
    const c = Math.cos(this.player.yaw);
    return Math.atan2(dx * c - dz * s, -dx * s - dz * c);
  }

  private die(): void {
    audio.gameOver();
    audio.stopMusic();
    audio.announce('gameover', 1.5);
    this.hud.banner('YOU DIED', 3, '#d22f26');
    this.setState('gameover');
    this.input.exitLock();
    this.onGameOver(this.stats);
  }

  /* ------------------------------------------------------------ power-ups */

  private maybeDropPowerUp(x: number, z: number): void {
    this.killsSinceDrop++;
    if (this.dropsThisRound >= DROPS_PER_ROUND) return;
    if (this.killsSinceDrop < DROP_MIN_GAP) return;
    if (!this.rng.chance(DROP_CHANCE)) return;

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
      audio.announce(id);
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
          this.feedStation(e);
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

  /* ---------------------------------------------------------- the story */

  /** Radio chatter, banners and sounds for whatever just happened in the story. */
  private beats(list: StoryBeat[]): void {
    const c = this.quest.chapter;
    for (const beat of list) {
      switch (beat) {
        case 'power':
          this.say('power', 0, 2.6);
          break;
        case 'part':
          audio.pickup();
          this.hud.toast(`PART FOUND  ${this.quest.partsFound}/${this.quest.parts.length}`, '#7affd0', 2);
          this.say('part', this.quest.partsFound - 1);
          break;
        case 'parts':
          audio.pickup();
          audio.objective();
          this.hud.toast(this.quest.parts.length === 1 ? `${this.quest.partNames[0]} FOUND` : 'ALL PARTS FOUND', '#7affd0', 2.4);
          this.say('parts');
          break;
        case 'built':
          audio.objective();
          audio.callout('objective', 0.8);
          this.hud.banner(`${c.device} BUILT`, 2.6, '#7affd0');
          this.retro.setTint(0x7affd0, 0.35);
          this.say('built');
          break;
        case 'valve': {
          audio.objective();
          const name = this.quest.step('valves')?.name ?? 'VALVE';
          this.hud.toast(`${name} OPEN  ${this.quest.valvesOpen}/${this.quest.valves.length}  ·  MOVE!`, '#ffc84d', 2.2);
          this.say('valve', this.quest.valvesOpen - 1);
          break;
        }
        case 'valves':
          audio.objective();
          audio.callout('objective', 0.8);
          this.hud.banner(`${this.quest.step('valves')?.name ?? 'VALVE'}S OPEN`, 2.6, '#7affd0');
          this.retro.setTint(0x7affd0, 0.35);
          this.say('valves', 0, 0.8);
          break;
        case 'valvesLost':
          audio.deny();
          audio.steam();
          audio.callout('setback', 0.3);
          this.hud.banner('PRESSURE LOST', 2.4, '#d22f26');
          this.hud.toast('THEY ALL SHUT AGAIN  ·  OPEN THEM FASTER', '#d22f26', 2.6);
          this.say('valvesLost');
          break;
        case 'harvest':
          this.hud.toast(`${this.quest.step('harvest')?.text ?? 'FEED IT'}  ·  KILL THEM INSIDE THE RING`, '#ff6a4a', 3);
          break;
        case 'harvestHalf':
          this.say('harvestHalf');
          break;
        case 'harvested':
          audio.objective();
          audio.callout('objective', 0.6);
          this.hud.banner(`THE ${c.device} IS READY`, 2.6, '#7affd0');
          this.retro.setTint(0xff6a4a, 0.35);
          this.say('harvested', 0, 0.6);
          break;
        case 'defend':
          audio.callout('defend', 1.2);
          this.hud.toast(`DEFEND THE ${c.device}  ·  STAY INSIDE THE RING`, '#ffc84d', 3);
          break;
        case 'defendHalf':
          this.say('defendHalf');
          break;
        case 'defended':
          audio.objective();
          audio.callout('objective', 0.6);
          this.hud.banner(`${c.device} COMPLETE`, 2.6, '#7affd0');
          this.retro.setTint(0x7affd0, 0.35);
          this.say('defended', 0, 0.6);
          break;
        case 'boss':
          audio.bossRoar(undefined, BOSS_PITCH[c.boss]);
          this.hud.banner(c.bossName, 3.2, '#d22f26');
          this.shake = Math.max(this.shake, 3);
          this.say('boss', 0, 1.2);
          break;
        case 'bossDown':
          audio.objective();
          this.hud.banner(`${c.bossName} IS DEAD`, 3.2, '#ffc84d');
          this.hud.toast('THE WAY OUT IS OPEN', '#7bd14a', 3);
          this.say('bossDown', 0, 1.6);
          break;
        case 'start':
        case 'escaped':
          break;
      }
    }
    this.syncQuestProps();
  }

  /** Voss says his line for a beat, now or after a delay. */
  private say(beat: StoryBeat, n = 0, delay = 0): void {
    const text = this.quest.radioLine(beat, n);
    if (!text) return;
    if (delay > 0) {
      this.radioQueue.push({ at: this.runSeconds + delay, text });
      return;
    }
    this.hud.radio(RADIO_NAME, text);
    audio.radio();
  }

  private sayLater(beat: StoryBeat, delay: number): void {
    this.say(beat, 0, delay);
  }

  private syncQuestProps(): void {
    const q = this.quest;
    const qp = this.questProps;
    qp.parts.forEach((p, i) => p.setTaken(q.parts[i]));
    qp.valves.forEach((v, i) => v.set(q.valves[i], q.canOpenValves));
    qp.bench.setBuilt(q.deviceOn);
    qp.bench.setParts(q.parts);
    qp.bench.setReady(q.canBuild);
    qp.exit.setOpen(q.boss === 'dead');
  }

  private takePart(i: number): void {
    const part = this.questProps.parts[i];
    const beats = this.quest.takePart(i);
    if (!beats.length) return;
    for (let k = 0; k < 18; k++) {
      this.particles.spawn(part.center.x, part.center.y + 0.6, part.center.z,
        this.rng.range(-3, 3), this.rng.range(1, 6), this.rng.range(-3, 3),
        PART_SPARK, this.rng.range(0.3, 0.8), 6);
    }
    this.beats(beats);
  }

  private openValve(i: number): void {
    const valve = this.questProps.valves[i];
    const beats = this.quest.openValve(i);
    if (!beats.length) {
      audio.deny();
      return;
    }
    audio.valve({ x: valve.center.x, z: valve.center.z });
    for (let k = 0; k < 24; k++) {
      this.particles.spawn(valve.center.x, valve.center.y + 0.4, valve.center.z,
        this.rng.range(-2, 2), this.rng.range(3, 8), this.rng.range(-2, 2),
        DUST_COLOR, this.rng.range(0.5, 1.2), -2);
    }
    this.beats(beats);
  }

  private buildDevice(): void {
    if (!this.quest.canBuild) {
      audio.deny();
      return;
    }
    const at = this.questProps.bench.center;
    for (let k = 0; k < 30; k++) {
      this.particles.spawn(at.x, at.y + 0.6, at.z,
        this.rng.range(-4, 4), this.rng.range(2, 8), this.rng.range(-4, 4),
        k % 2 ? SPARK_COLOR : PART_SPARK, this.rng.range(0.3, 0.9), 20);
    }
    audio.buy();
    this.shake = Math.max(this.shake, 1.2);
    this.beats(this.quest.build());
  }

  private tryEscape(): void {
    if (!this.quest.canEscape) {
      audio.deny();
      const hint = this.quest.built ? 'NOT WHILE IT IS STILL OUT THERE' : 'SEALED. FINISH THE JOB FIRST';
      this.hud.toast(hint, '#d22f26', 1.6);
      return;
    }
    this.quest.escape();
    audio.stopMusic();
    audio.victory();
    this.hud.clearRadio();
    this.hud.setWaypoint(null);
    this.hud.setBoss(null);
    this.hud.setPrompt(null);
    this.retro.setTint(0xffffff, 0.5);
    this.setState('victory');
    this.input.exitLock();
    this.onVictory(this.stats);
  }

  get bossAlive(): boolean {
    const b = this.pool.boss;
    return Boolean(b && b.active && b.state !== 'dead');
  }

  private updateQuest(dt: number): void {
    while (this.radioQueue.length && this.radioQueue[0].at <= this.runSeconds) {
      const line = this.radioQueue.shift();
      if (line) {
        this.hud.radio(RADIO_NAME, line.text);
        audio.radio();
      }
    }
    // The clocks: valve pressure, the defence (only while you are in the ring) and the boss.
    const station = this.questProps.bench.center;
    const near = this.player.alive
      && Math.hypot(this.player.x - station.x, this.player.z - station.z) < STATION_RADIUS
      && this.grid.lineOfSight(station.x, station.z, this.player.x, this.player.z);
    const timer = this.quest.valveTimer;
    const before = this.quest.bossTimer;
    const beats = this.quest.tick(dt, near);
    if (beats.length) this.beats(beats);
    // The last ten seconds of pressure tick away out loud.
    if (this.quest.valveTimer > 0 && this.quest.valveTimer < 10 && Math.ceil(this.quest.valveTimer) !== Math.ceil(timer)) {
      audio.countdown(this.quest.valveTimer < 4);
    }
    const q = this.quest;
    this.questProps.ring.set(q.defending ? 'defend' : q.harvesting ? 'harvest' : null);
    const d = q.step('defend');
    const h = q.step('harvest');
    this.questProps.bench.setCharge(q.defending && d ? q.held / d.seconds : q.harvesting && h ? q.kills / h.kills : 0);
    if (this.quest.bossDue) this.spawnBoss();
    // Something is coming: a distant roar halfway through the wait.
    if (this.quest.boss === 'coming' && before > BOSS_DELAY / 2 && this.quest.bossTimer <= BOSS_DELAY / 2) {
      audio.bossRoar(undefined, BOSS_PITCH[this.quest.chapter.boss] * 0.9);
      this.shake = Math.max(this.shake, 1.2);
    }

    const boss = this.pool.boss;
    if (boss instanceof BossEnemy && boss.active && boss.state !== 'dead') {
      if (boss.spec.light) {
        boss.lightPosition(this.bossLight.position);
        this.bossLight.color.setHex(boss.spec.light);
        this.bossLight.intensity = 34 + Math.sin(this.elapsed * 13) * 6 + (boss.enraged ? 14 : 0);
      }
      if (boss.id === 'furnace' && this.rng.chance(dt * 40)) {
        this.particles.spawn(boss.x + this.rng.range(-1, 1), boss.y + this.rng.range(1, boss.model.height), boss.z + this.rng.range(-1, 1),
          this.rng.range(-0.5, 0.5), this.rng.range(2, 4), this.rng.range(-0.5, 0.5),
          FIRE_COLORS[this.rng.int(3)], this.rng.range(0.4, 0.8), -3);
      }
    } else {
      this.bossLight.intensity = 0;
    }
    // Once the body has sunk away, the boss leaves play.
    if (boss && !boss.active) this.pool.removeBoss();
  }

  private spawnBoss(): void {
    const id = this.quest.chapter.boss;
    let boss = this.bosses.get(id);
    if (!boss) {
      boss = new BossEnemy(id);
      this.bosses.set(id, boss);
    }
    const win = this.pickBossWindow();
    let x: number;
    let z: number;
    if (win) {
      x = win.center.x + win.def.dx * TILE * 2;
      z = win.center.z + win.def.dz * TILE * 2;
    } else {
      const spot = this.farFloor();
      if (!spot) return;
      x = spot.x;
      z = spot.z;
    }
    this.pool.addBoss(boss);
    boss.begin(x, z, bossHealth(id, Math.max(1, this.round)), win, this.rng, this.bossHooks);
    this.beats(this.quest.bossArrived());
    audio.callout('boss', 1.8);
  }

  /** A window in the open part of the map, a fair way off. */
  private pickBossWindow(): BarricadeProp | null {
    let best: BarricadeProp | null = null;
    let bestScore = Infinity;
    for (const b of this.props.barricades) {
      if (!this.openZones.has(b.def.zone)) continue;
      const d = Math.hypot(b.center.x - this.player.x, b.center.z - this.player.z);
      const score = Math.abs(d - 30) + (d < 14 ? 100 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  /** The middle of the open room farthest from the player. */
  private farFloor(): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = -1;
    for (const zone of this.layout.zones) {
      if (!this.openZones.has(zone.id)) continue;
      const tx = zone.rect.x + Math.floor(zone.rect.w / 2);
      const tz = zone.rect.z + Math.floor(zone.rect.h / 2);
      if (this.grid.tiles[tz * MAP_W + tx] !== T_FLOOR) continue;
      const c = tileCenter(tx, tz);
      const d = Math.hypot(c.x - this.player.x, c.z - this.player.z);
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  private onBossKilled(e: Enemy): void {
    const bounty = BOSS_BOUNTY * (this.activePowerups.has('doublepoints') ? 2 : 1);
    this.player.award(bounty);
    this.hud.pointsDelta(bounty);
    this.hud.setPoints(this.player.points);
    this.spawnDrop('maxammo', e.x, e.z);
    for (let i = 0; i < 60; i++) {
      this.particles.spawn(e.x, e.y + this.rng.range(1, e.model.height), e.z,
        this.rng.range(-9, 9), this.rng.range(2, 14), this.rng.range(-9, 9),
        BLOOD_COLOR, this.rng.range(0.4, 1.2), 26);
    }
    audio.bossRoar({ x: e.x, z: e.z }, BOSS_PITCH[this.quest.chapter.boss] * 0.7);
    this.shake = Math.max(this.shake, 4);
    this.retro.setTint(0xffffff, 0.35);
    this.bossLight.intensity = 0;
    this.beats(this.quest.bossKilled());
    audio.callout('bossDown', 1.4);
  }

  /** Shoves the player away from a point. */
  private knockPlayer(fromX: number, fromZ: number, strength: number): void {
    const p = this.player;
    let dx = p.x - fromX;
    let dz = p.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    p.pushX += dx * strength;
    p.pushZ += dz * strength;
    if (p.grounded) {
      p.vy = 4.5;
      p.grounded = false;
    }
  }

  private makeBossHooks(): BossHooks {
    return {
      slam: (b, radius, damage) => {
        audio.slam({ x: b.x, z: b.z });
        this.shake = Math.max(this.shake, 3.6);
        for (let i = 0; i < 44; i++) {
          const a = (i / 44) * Math.PI * 2;
          const s = this.rng.range(9, 17);
          this.particles.spawn(b.x + Math.cos(a) * 1.2, 0.4, b.z + Math.sin(a) * 1.2,
            Math.cos(a) * s, this.rng.range(1, 4), Math.sin(a) * s,
            DUST_COLOR, this.rng.range(0.3, 0.7), 18);
        }
        this.placeDecal(b.x, 0.05, b.z, 0, 0, false, radius * 0.45);
        const d = Math.hypot(this.player.x - b.x, this.player.z - b.z);
        // A jump clears the shockwave.
        if (d < radius && this.player.y < 0.8 && this.player.alive) {
          const k = 1 - d / radius;
          this.hurtPlayer(Math.round(damage * (0.45 + 0.55 * k)), b);
          this.knockPlayer(b.x, b.z, 8 + 14 * k);
        }
      },
      lob: (_b, kind, x, y, z, toX, toZ) => this.lobShot(kind, x, y, z, toX, toZ),
      summon: (b, kind, count) => {
        const health = kind === 'hound' ? houndHealth(Math.max(1, this.round)) : enemyHealth(Math.max(1, this.round));
        for (let i = 0; i < count; i++) {
          const e = this.pool.acquire(kind);
          if (!e) break;
          let x = b.x;
          let z = b.z;
          for (let tries = 0; tries < 10; tries++) {
            const a = this.rng.range(0, Math.PI * 2);
            const r = this.rng.range(3, 7);
            const cx = b.x + Math.cos(a) * r;
            const cz = b.z + Math.sin(a) * r;
            if (this.grid.lineOfSight(b.x, b.z, cx, cz)) {
              x = cx;
              z = cz;
              break;
            }
          }
          e.spawn(kind, x, z, health, Math.max(1, this.round), null, this.rng, this.quest.threat);
          for (let k = 0; k < 14; k++) {
            this.particles.spawn(x, 0.5, z, this.rng.range(-3, 3), this.rng.range(2, 7), this.rng.range(-3, 3),
              kind === 'hound' ? EMBER_COLOR : ACID_COLOR, this.rng.range(0.3, 0.7), 12);
          }
        }
        this.hud.toast(kind === 'hound' ? 'HE CALLED HIS DOGS' : 'THEY ANSWER HIM', '#ff6a2a', 2);
      },
      roar: (b) => {
        audio.bossRoar({ x: b.x, z: b.z }, BOSS_PITCH[b.id]);
        this.shake = Math.max(this.shake, 2.4);
        this.retro.setTint(0xff3020, 0.22);
      },
      telegraph: (b, move: BossMove) => {
        const at = { x: b.x, z: b.z };
        if (move === 'charge') audio.bossRoar(at, BOSS_PITCH[b.id] * 1.3);
        else audio.zombieVoice(at, move === 'leap' ? 'scream' : move === 'throw' ? 'snarl' : 'growl', 0.5);
      },
      strike: (b, damage, knock) => {
        this.hurtPlayer(damage, b);
        this.knockPlayer(b.x, b.z, knock);
        audio.slam({ x: b.x, z: b.z });
        this.shake = Math.max(this.shake, 3.2);
      },
      crash: (b) => {
        audio.slam({ x: b.x, z: b.z });
        this.shake = Math.max(this.shake, 2.6);
        for (let i = 0; i < 24; i++) {
          this.particles.spawn(b.x, this.rng.range(1, 4), b.z, this.rng.range(-6, 6), this.rng.range(1, 6), this.rng.range(-6, 6),
            DUST_COLOR, this.rng.range(0.3, 0.8), 20);
        }
        this.hud.toast('STUNNED — HIT IT NOW', '#ffc84d', 1.4);
      },
    };
  }

  private readonly shotGeo = new THREE.OctahedronGeometry(0.55, 0);
  private readonly shotMats = {
    fireball: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.8, 0.3) }),
    acid: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3.2, 0.9) }),
  };
  private readonly hazardGeo = new THREE.CircleGeometry(1, 14);

  /** Throws a shot in an arc that lands on a point. */
  private lobShot(kind: 'fireball' | 'acid', x: number, y: number, z: number, toX: number, toZ: number): void {
    const dx = toX - x;
    const dz = toZ - z;
    const d = Math.hypot(dx, dz) || 1;
    const t = THREE.MathUtils.clamp(d / 22, 0.55, 1.7);
    const mesh = new THREE.Mesh(this.shotGeo, this.shotMats[kind]);
    mesh.position.set(x, y, z);
    if (kind === 'acid') mesh.scale.setScalar(0.8);
    this.scene.add(mesh);
    this.bossShots.push({
      mesh, kind, x, y, z,
      vx: dx / t, vz: dz / t, vy: (0.3 - y) / t + 0.5 * SHOT_GRAVITY * t,
      life: 4,
    });
    if (kind === 'fireball') audio.fireBurst({ x, z });
    else audio.zombieVoice({ x, z }, 'snarl', 0.7);
  }

  private updateBossShots(dt: number): void {
    const p = this.player;
    for (let i = this.bossShots.length - 1; i >= 0; i--) {
      const s = this.bossShots[i];
      s.vy -= SHOT_GRAVITY * dt;
      const nx = s.x + s.vx * dt;
      const ny = s.y + s.vy * dt;
      const nz = s.z + s.vz * dt;
      s.life -= dt;
      let hit = s.life <= 0;
      let hx = nx;
      let hz = nz;
      const step = Math.hypot(nx - s.x, nz - s.z);
      if (step > 1e-3) {
        const w = this.grid.raycast(s.x, s.z, (nx - s.x) / step, (nz - s.z) / step, step, this.torn);
        if (w.hit) {
          hit = true;
          hx = w.x;
          hz = w.z;
        }
      }
      if (ny <= 0.3) hit = true;
      if (Math.hypot(nx - p.x, nz - p.z) < 1.4 && ny > p.y && ny < p.y + 4) hit = true;
      s.x = nx;
      s.y = ny;
      s.z = nz;
      s.mesh.position.set(nx, ny, nz);
      s.mesh.rotation.x += dt * 7;
      s.mesh.rotation.y += dt * 5;
      const trail = s.kind === 'fireball' ? FIRE_COLORS[this.rng.int(3)] : ACID_COLOR;
      this.particles.spawn(nx, ny, nz, this.rng.range(-1, 1), this.rng.range(0, 2), this.rng.range(-1, 1), trail, this.rng.range(0.2, 0.45), -2);
      if (hit) {
        this.burstShot(s, hx, Math.max(0.3, Math.min(ny, WALL_H - 0.5)), hz);
        this.scene.remove(s.mesh);
        this.bossShots.splice(i, 1);
      }
    }
  }

  private burstShot(s: BossShot, x: number, y: number, z: number): void {
    const fire = s.kind === 'fireball';
    for (let k = 0; k < 26; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const v = this.rng.range(2, 8);
      this.particles.spawn(x, y, z, Math.cos(a) * v, this.rng.range(1, 7), Math.sin(a) * v,
        fire ? FIRE_COLORS[k % 3] : ACID_COLOR, this.rng.range(0.3, 0.8), fire ? -2 : 14);
    }
    if (fire) audio.fireBurst({ x, z });
    else audio.flesh({ x, z }, true);
    const d = Math.hypot(this.player.x - x, this.player.z - z);
    if (d < 4.2 && this.player.y < y + 3) this.hurtPlayer(Math.round(30 * (1 - (d / 4.2) * 0.6)), { x, z });
    // Whatever lands leaves the ground burning or bubbling for a while.
    const radius = fire ? 3.4 : 3.0;
    const mat = new THREE.MeshBasicMaterial({
      color: fire ? new THREE.Color(2.6, 0.9, 0.15) : new THREE.Color(0.4, 2.0, 0.5),
      transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.hazardGeo, mat);
    mesh.scale.set(radius, radius, 1);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.07, z);
    this.scene.add(mesh);
    this.hazards.push({ mesh, kind: s.kind, x, z, radius, dps: fire ? 24 : 18, life: fire ? 4.5 : 6 });
  }

  private updateHazards(dt: number): void {
    const p = this.player;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      const mat = h.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(0.75, h.life * 0.6) * (0.85 + 0.15 * Math.sin(this.elapsed * 12 + i));
      if (this.rng.chance(dt * 16)) {
        const a = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(0, h.radius);
        this.particles.spawn(h.x + Math.cos(a) * r, 0.2, h.z + Math.sin(a) * r, 0, this.rng.range(1, 3), 0,
          h.kind === 'fireball' ? FIRE_COLORS[this.rng.int(3)] : ACID_COLOR, this.rng.range(0.3, 0.7), -2);
      }
      if (p.alive && p.y < 0.6 && Math.hypot(p.x - h.x, p.z - h.z) < h.radius) this.hazardHurt += h.dps * dt;
      if (h.life <= 0) {
        this.scene.remove(h.mesh);
        mat.dispose();
        this.hazards.splice(i, 1);
      }
    }
    if (this.hazardHurt >= 7) {
      this.hurtPlayer(Math.round(this.hazardHurt));
      this.hazardHurt = 0;
    }
  }

  private clearBossEffects(): void {
    for (const s of this.bossShots) this.scene.remove(s.mesh);
    this.bossShots.length = 0;
    for (const h of this.hazards) {
      this.scene.remove(h.mesh);
      (h.mesh.material as THREE.Material).dispose();
    }
    this.hazards.length = 0;
    this.hazardHurt = 0;
    this.bossLight.intensity = 0;
  }

  /** Where the objective marker points: the next thing the story needs. */
  private objectiveTarget(): THREE.Vector3 | null {
    const q = this.quest;
    switch (q.stage) {
      case 'power':
        return this.tmpTarget.copy(this.props.power.center);
      case 'parts': {
        let best: THREE.Vector3 | null = null;
        let bestD = Infinity;
        for (const part of this.questProps.parts) {
          if (part.taken) continue;
          const d = Math.hypot(part.center.x - this.player.x, part.center.z - this.player.z);
          if (d < bestD) {
            bestD = d;
            best = part.center;
          }
        }
        return best ? this.tmpTarget.copy(best) : null;
      }
      case 'valves': {
        let best: THREE.Vector3 | null = null;
        let bestD = Infinity;
        for (const v of this.questProps.valves) {
          if (v.open) continue;
          const d = Math.hypot(v.center.x - this.player.x, v.center.z - this.player.z);
          if (d < bestD) {
            bestD = d;
            best = v.center;
          }
        }
        return best ? this.tmpTarget.copy(best) : null;
      }
      case 'build':
      case 'harvest':
      case 'defend':
        return this.tmpTarget.copy(this.questProps.bench.center);
      case 'boss': {
        const b = this.pool.boss;
        if (!b || !b.active || b.state === 'dead' || b.state === 'approach') return null;
        return this.tmpTarget.set(b.x, b.headY + 1.2, b.z);
      }
      case 'escape':
        return this.tmpTarget.copy(this.questProps.exit.center);
      default:
        return null;
    }
  }

  /** Puts the objective marker on screen, or pins it to the edge pointing the way. */
  private updateWaypoint(): void {
    const t = this.objectiveTarget();
    if (!t || !this.player.alive || this.state !== 'playing') {
      this.hud.setWaypoint(null);
      return;
    }
    const dist = Math.hypot(t.x - this.player.x, t.z - this.player.z);
    if (dist < 4.5) {
      this.hud.setWaypoint(null);
      return;
    }
    this.camera.updateMatrixWorld();
    const v = this.tmpV.copy(t).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = v.z > -0.5;
    let sx: number;
    let sy: number;
    if (behind) {
      // Behind the camera: slide it round to the edge on the side it is on.
      sx = v.x;
      sy = -Math.abs(v.y) - Math.abs(v.z) * 0.3;
    } else {
      v.applyMatrix4(this.camera.projectionMatrix);
      sx = v.x;
      sy = v.y;
    }
    // Off screen it rides an ellipse inside the edges, clear of the HUD corners.
    const k = Math.hypot(sx / 0.86, sy / 0.72);
    const edge = behind || k > 1;
    if (edge) {
      sx /= Math.max(k, 1e-6);
      sy /= Math.max(k, 1e-6);
    }
    this.hud.setWaypoint((sx * 0.5 + 0.5) * window.innerWidth, (-sy * 0.5 + 0.5) * window.innerHeight, dist / 2, edge);
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
      const tier = p.slot.tier;
      const maxed = tier >= PAP_MAX;
      consider(
        this.props.pack.center.x, this.props.pack.center.z,
        maxed ? `${tierName(p.weapon.name, tier)} IS MAXED OUT` : `PACK-A-PUNCH TO TIER ${['I', 'II', 'III'][tier]}`,
        maxed ? 0 : papCost(tier),
        () => this.packWeapon(), 5.5,
      );
    }

    for (const u of this.boxes.units) {
      if (!u.enabled) continue;
      const c = u.prop.center;
      if (u.state === 'offer' && u.buyer && u.offer) {
        const def = getWeapon(u.offer);
        consider(c.x, c.z, `TAKE ${def.name} · ${RARITY_INFO[def.rarity].name}`, 0, () => this.takeBoxWeapon(u), 5.5);
      } else if (u.state === 'idle') {
        consider(c.x, c.z, 'MYSTERY BOX', MYSTERY_BOX_COST, () => this.rollBox(u), 5.5);
      }
    }

    const q = this.quest;
    const qp = this.questProps;
    for (const part of qp.parts) {
      if (part.taken) continue;
      consider(part.center.x, part.center.z, `PICK UP THE ${q.partNames[part.index]}`, 0, () => this.takePart(part.index), 5);
    }
    const valveName = q.step('valves')?.name ?? 'VALVE';
    for (const v of qp.valves) {
      if (v.open) continue;
      const label = q.canOpenValves ? `OPEN THE ${valveName}` : `${valveName} — ${q.power ? 'LOCKED' : 'NEEDS POWER'}`;
      consider(v.center.x, v.center.z, label, 0, () => this.openValve(v.index), 5);
    }
    if (q.step('build') && !q.built) {
      const missing = q.parts.length - q.partsFound;
      const label = q.canBuild
        ? `BUILD THE ${q.chapter.device}`
        : missing > 0
          ? `WORKBENCH — ${missing} PART${missing > 1 ? 'S' : ''} MISSING`
          : `WORKBENCH — NEEDS POWER`;
      consider(qp.bench.center.x, qp.bench.center.z, label, 0, () => this.buildDevice(), 5.5);
    }
    if (!q.escaped) {
      consider(
        qp.exit.center.x, qp.exit.center.z,
        q.canEscape ? `ESCAPE THROUGH ${q.chapter.exit}` : `${q.chapter.exit} — SEALED`, 0,
        () => this.tryEscape(), 5.5,
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
    audio.callout('perk', 1.1);
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
    this.beats(this.quest.powerOn());
  }

  /**
   * Pack-a-Punch, one tier at a time: more damage, a bigger magazine and a new
   * camo each time, and at tier II an elemental ammo mod.
   */
  private packWeapon(): void {
    const slot = this.player.slot;
    if (slot.tier >= PAP_MAX) {
      audio.deny();
      return;
    }
    const cost = papCost(slot.tier);
    if (!this.player.spend(cost)) {
      audio.deny();
      return;
    }
    const def = getWeapon(slot.id);
    slot.tier++;
    let note = '';
    if (slot.tier >= 2 && !slot.mod) {
      slot.mod = AMMO_MOD_IDS[this.rng.int(AMMO_MOD_IDS.length)];
      note = `  +  ${AMMO_MODS[slot.mod].name}`;
    }
    slot.mag = magFor(def, slot.tier);
    slot.reserve = reserveFor(def, slot.tier);
    this.equipCurrent();
    this.viewmodel.setPose('raise', 0.4);
    this.props.pack.showWeapon(slot.id);
    window.setTimeout(() => this.props.pack.showWeapon(null), 1800);
    audio.perkJingle();
    audio.callout('packed', 0.9);
    this.syncAmmoHud();
    this.finishPurchase(cost, tierName(def.name, slot.tier) + note, false);
  }

  private rollBox(u: BoxUnit): void {
    if (u.state !== 'idle') return;
    if (!this.player.spend(MYSTERY_BOX_COST)) {
      audio.deny();
      return;
    }
    this.boxes.roll(u);
    audio.musicBox();
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(-MYSTERY_BOX_COST);
  }

  private takeBoxWeapon(u: BoxUnit): void {
    const id = this.boxes.take(u);
    if (!id) return;
    this.player.giveWeapon(id);
    this.equipCurrent();
    this.viewmodel.setPose('raise', 0.32);
    this.syncAmmoHud();
    audio.buy();
    const def = getWeapon(id);
    this.hud.toast(def.name, css(RARITY_INFO[def.rarity].color), 2);
  }

  /** The box has settled on a gun: sound and show how rare it is. */
  private onBoxReveal(u: BoxUnit, id: string): void {
    const def = getWeapon(id);
    const info = RARITY_INFO[def.rarity];
    audio.reveal(def.rarity);
    if (!u.buyer) return;
    this.hud.toast(`${info.name}  ·  ${def.name}`, css(info.color), 2.8);
    if (def.rarity === 'legendary') {
      this.hud.banner('LEGENDARY', 2.4, css(info.color));
      this.legendaryFlash = 1;
      audio.callout('legendary', 0.7);
    }
  }

  /** A teddy bear: points back, and the box is off somewhere else. */
  private onBoxBear(_u: BoxUnit): void {
    this.player.award(MYSTERY_BOX_COST);
    this.hud.setPoints(this.player.points);
    this.hud.pointsDelta(MYSTERY_BOX_COST);
    audio.teddy();
    audio.callout('teddy', 0.5);
    this.hud.toast('THE BOX IS MOVING  ·  POINTS REFUNDED', '#ff6a4a', 2.8);
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
    const mod = s.mod ? { name: AMMO_MODS[s.mod].name, color: css(AMMO_MODS[s.mod].color) } : null;
    this.hud.setWeapon(tierName(def.name, s.tier), s.mag, s.reserve, magFor(def, s.tier), mod);
  }

  /* ---------------------------------------------------------------- frame */

  update(dt: number): void {
    this.elapsed += dt;

    if (this.state !== 'playing') {
      if (!this.hostPresents) this.present(dt);
      this.input.endFrame();
      return;
    }

    this.runSeconds += dt;
    this.handleLook(dt);
    this.handleActions();
    this.updatePlayer(dt);
    this.updateRound(dt);
    this.updateEnemies(dt);
    this.updateQuest(dt);
    this.updateBossShots(dt);
    this.updateHazards(dt);
    this.updateProjectiles(dt);
    this.updateDrops(dt);
    this.updateBox(dt);
    this.updateProps(dt);
    this.updateEffects(dt);
    this.updateCamera(dt);
    if (!this.hostPresents) this.present(dt);
    this.input.endFrame();
  }

  /**
   * Everything the player reads rather than plays: the HUD, the bars and
   * numbers over the horde, the objective marker and the minimap.
   *
   * All of it is DOM and canvas work whose only consumer is the screen, so it
   * belongs once per drawn frame rather than once per simulation step - at
   * 120 Hz that would repaint it two to four times over, and because the tags
   * measure the window after writing eighty inline styles, each repeat costs a
   * forced layout. The cost also grew with the number of steps a frame took,
   * which is the wrong way round: a frame that is already late did the most
   * redundant work.
   */
  present(dt: number): void {
    // The HUD's own timers (the radio typing itself out, a toast fading) belong
    // to the run: they hold still while it is paused, but still run down on the
    // death and victory screens, where the last banner is still on its way out.
    if (this.state !== 'paused') this.hud.update(dt);
    if (this.state !== 'playing') return;
    this.updateHud();
    this.updateWaypoint();
    this.tags.update(dt, this.camera, this.player, this.grid);
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
      this.hud.setPrompt(
        `<b>${this.input.label('use')}</b> ${target.label}${costText}`, target.affordable,
      );
      const b = target.repair;
      if (b) {
        if (this.input.isDown('use')) {
          this.repairHold += dt;
          if (this.repairHold >= 0.42) {
            this.repairHold = 0;
            if (b.addBoard()) {
              this.torn.delete(this.grid.idx(b.def.tx, b.def.tz));
              this.grid.invalidateField();
              p.award(SCORE_REPAIR);
              this.hud.pointsDelta(SCORE_REPAIR);
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
    const dmg = this.activePowerups.has('instakill') && !target.isBoss ? 1e6 : def.damage;
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

    // While the station is defended the horde surges: faster spawns, and the round cannot end.
    const surge = this.quest.defending;
    this.spawnTimer -= dt * (surge ? 1.8 : 1);
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.plan.interval;
      this.trySpawn();
    }

    if (!surge && this.spawned >= this.plan.total && this.pool.liveCount === 0) this.endRound();

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
          // A boss's swing hurts less than a brute's but throws you across the room.
          this.hurtPlayer(enemy.isBoss ? 45 : dmg, enemy);
          if (enemy.isBoss) {
            this.knockPlayer(enemy.x, enemy.z, 14);
            audio.slam({ x: enemy.x, z: enemy.z });
            this.shake = Math.max(this.shake, 2.2);
          }
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

    for (const e of this.pool.all) {
      if (!e.active || e.state === 'dead' || e.burning <= 0) continue;
      this.damageEnemy(e, e.burnDps * dt, false, false, new THREE.Vector3(e.x, e.y + 2, e.z), e, { quiet: true });
      if (this.rng.chance(dt * 22)) {
        this.particles.spawn(e.x + this.rng.range(-0.5, 0.5), e.y + this.rng.range(0.5, e.model.height), e.z + this.rng.range(-0.5, 0.5),
          this.rng.range(-0.6, 0.6), this.rng.range(1.5, 3.5), this.rng.range(-0.6, 0.6),
          FIRE_COLORS[this.rng.int(3)], this.rng.range(0.3, 0.6), -2);
      }
    }

    const probe = this.level.probe;
    for (const e of this.pool.all) {
      if (!e.active) continue;
      probe.sample(e.x, e.z, this.tmpLight);
      if (e.frozen > 0) this.tmpLight.lerp(ICE_TINT, 0.7);
      if (e.burning > 0) this.tmpLight.lerp(FIRE_TINT, 0.35 + 0.15 * Math.sin(this.elapsed * 30 + e.x));
      if (e.shocked > 0) this.tmpLight.addScalar(Math.random() * 1.5);
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
    this.boxes.update(dt, this.elapsed);
  }

  private updateProps(dt: number): void {
    for (const d of this.props.doors) d.update(dt);
    this.level.update(this.elapsed);
    for (const m of this.props.machines) m.animate(this.elapsed);
    for (const w of this.props.wallBuys) w.animate(this.elapsed);
    this.props.pack.animate(this.elapsed);
    for (const part of this.questProps.parts) part.animate(this.elapsed);
    for (const v of this.questProps.valves) v.animate(this.elapsed, dt);
    this.questProps.bench.animate(this.elapsed);
    this.questProps.ring.animate(this.elapsed);
    this.questProps.exit.animate(this.elapsed, dt);
  }

  private updateEffects(dt: number): void {
    this.particles.update(dt);
    this.elements.update(dt);
    this.modCooldown = Math.max(0, this.modCooldown - dt);
    if (this.legendaryFlash > 0) this.legendaryFlash = Math.max(0, this.legendaryFlash - dt * 1.2);

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
    if (this.legendaryFlash > 0) this.retro.setTint(0xffc23a, this.legendaryFlash * 0.3);
    else if (instaKill) this.retro.setTint(0xff4040, 0.16);
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

    // Fog eases toward whichever room the player is standing in, and opens
    // right out under the sky.
    const { tx, tz } = worldToTile(p.x, p.z);
    const here = lookAt(this.layout, zoneAt(this.layout, tx, tz));
    this.fogTarget.set(here.fog);
    this.fog.color.lerp(this.fogTarget, Math.min(1, dt * 1.6));
    const [near, far] = here.outdoor ? FOG_OUTDOOR : FOG_INDOOR;
    const k = Math.min(1, dt * 1.2);
    this.fog.near += (near - this.fog.near) * k;
    this.fog.far += (far - this.fog.far) * k;
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

  private updateHud(): void {
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
    this.hud.setObjectives(this.quest.objectives());
    const boss = this.pool.boss;
    if (boss && boss.active && boss.state !== 'dead' && boss instanceof BossEnemy) {
      this.hud.setBoss(this.quest.chapter.bossName, boss.healthFraction, boss.enraged);
    } else {
      this.hud.setBoss(null);
    }

    if (this.hud.mapVisible) {
      const blips: MinimapBlip[] = [];
      const target = this.objectiveTarget();
      if (target) blips.push({ x: target.x, z: target.z, color: '#7affd0', size: 2.2 });
      this.pool.forEachLive((e) =>
        blips.push({ x: e.x, z: e.z, color: e.kind === 'hound' ? '#ff6a2a' : '#d22f26' }),
      );
      for (const u of this.boxes.units) {
        if (u.enabled && u.state !== 'away' && u.state !== 'leaving') blips.push({ x: u.prop.center.x, z: u.prop.center.z, color: '#7ac8ff', size: 1.5 });
      }
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
