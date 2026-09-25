/**
 * Mystery boxes.
 *
 * Each box sits on one of the layout's pads with a faint beam over it. Pay,
 * and the lid opens and guns flick past as one rises out of it, slowing down
 * until it settles on the one you get - glowing the colour of its rarity. Take
 * it within nine seconds or it sinks back in. After a few pulls a teddy bear
 * comes up instead: you get your points back, the box flies off and lands on
 * another pad somewhere else in the building.
 *
 * Bigger maps run more than one box at a time; they never share a pad.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import type { LightProbe } from '../world/lighting.ts';
import type { WallProp, ZoneId } from '../world/mapdata.ts';
import { MysteryBox } from '../world/props.ts';
import { BOX_MOVE_MAX, BOX_MOVE_MIN } from './rules.ts';
import { BOX_POOL, RARITY_INFO, boxWeights, getWeapon } from './weapons.ts';

export type BoxState = 'idle' | 'rolling' | 'offer' | 'closing' | 'bear' | 'leaving' | 'away' | 'arriving';

export const ROLL_TIME = 3.6;
export const OFFER_TIME = 9;

export type BoxUnit = {
  prop: MysteryBox;
  state: BoxState;
  timer: number;
  offer: string | null;
  rolls: number;
  limit: number;
  /** Set while the player who paid can still take the gun. */
  buyer: boolean;
  flick: number;
  /** Maps with fewer boxes leave the spare ones switched off. */
  enabled: boolean;
};

export type BoxHooks = {
  /** Guns the player is carrying: the box never offers those. */
  owned(): string[];
  /** Zones the player can reach, for choosing where a box lands next. */
  openZones(): Set<ZoneId>;
  probe(): LightProbe;
  onReveal(unit: BoxUnit, weaponId: string): void;
  onBear(unit: BoxUnit): void;
  onMoved(unit: BoxUnit): void;
};

const IDLE_GLOW = 0x7ac8ff;
const ROLL_GLOW = 0xffc84d;

export class BoxController {
  readonly units: BoxUnit[] = [];
  private pads: WallProp[] = [];
  private readonly hooks: BoxHooks;
  private readonly rng: Rng;

  constructor(scene: THREE.Scene, maxBoxes: number, rng: Rng, hooks: BoxHooks) {
    this.hooks = hooks;
    this.rng = rng;
    for (let i = 0; i < maxBoxes; i++) {
      const prop = new MysteryBox();
      scene.add(prop.group);
      this.units.push({ prop, state: 'idle', timer: 0, offer: null, rolls: 0, limit: 6, buyer: false, flick: 0, enabled: false });
    }
  }

  /** Puts `count` boxes out for a new run: the first in the start room, the rest elsewhere. */
  reset(pads: WallProp[], count: number): void {
    this.pads = pads;
    const probe = this.hooks.probe();
    const used = new Set<number>();
    this.units.forEach((u, i) => {
      u.enabled = i < count;
      u.state = 'idle';
      u.timer = 0;
      u.offer = null;
      u.rolls = 0;
      u.buyer = false;
      u.limit = this.newLimit();
      u.prop.setLid(0);
      u.prop.showWeapon(null);
      u.prop.showBear(false);
      u.prop.setRise(0);
      u.prop.setGlow(IDLE_GLOW, 0);
      u.prop.setAway(i < count ? 0 : 1);
      u.prop.group.visible = i < count;
      if (i >= count) return;
      let pad = 0;
      if (i > 0) {
        // Somewhere away from the start room, and from the other boxes.
        const options = pads.map((_, k) => k).filter((k) => k !== 0 && !used.has(k) && pads[k].zone !== pads[0].zone);
        pad = options.length ? options[this.rng.int(options.length)] : Math.min(i, pads.length - 1);
      }
      used.add(pad);
      u.prop.moveTo(pads[pad], pad, probe);
    });
  }

  private newLimit(): number {
    return this.rng.int(BOX_MOVE_MAX - BOX_MOVE_MIN + 1) + BOX_MOVE_MIN;
  }

  /** Starts a roll on a box the player has just paid for. */
  roll(u: BoxUnit): void {
    u.state = 'rolling';
    u.timer = ROLL_TIME;
    u.buyer = true;
    u.rolls++;
    u.flick = 0;
    u.prop.setLid(1);
    u.prop.setGlow(ROLL_GLOW, 0.4);
  }

  /** The player took the gun out of this box. */
  take(u: BoxUnit): string | null {
    const id = u.offer;
    u.offer = null;
    u.prop.showWeapon(null);
    u.state = 'closing';
    u.timer = 0.5;
    return id;
  }

  update(dt: number, t: number): void {
    for (const u of this.units) {
      if (!u.enabled) continue;
      const box = u.prop;
      box.animate(t, t * 6);
      u.timer -= dt;
      switch (u.state) {
        case 'rolling': {
          box.setRise(1 - u.timer / ROLL_TIME);
          // Flick through guns, slowing toward the reveal.
          u.flick -= dt;
          if (u.flick <= 0) {
            u.flick = 0.05 + (1 - u.timer / ROLL_TIME) * 0.28;
            box.showWeapon(BOX_POOL[this.rng.int(BOX_POOL.length)]);
          }
          if (u.timer <= 0) this.finishRoll(u);
          break;
        }
        case 'offer':
          // The gun sinks back into the box as the offer runs out.
          box.setRise(Math.max(0, u.timer / OFFER_TIME));
          if (u.timer <= 0) {
            u.offer = null;
            box.showWeapon(null);
            u.state = 'closing';
            u.timer = 0.5;
          }
          break;
        case 'closing':
          box.setLid(Math.max(0, u.timer / 0.5));
          if (u.timer <= 0) {
            box.setLid(0);
            box.setRise(0);
            box.setGlow(IDLE_GLOW, 0);
            u.buyer = false;
            u.state = 'idle';
          }
          break;
        case 'bear':
          box.setRise(1);
          if (u.timer <= 0) {
            box.showBear(false);
            box.setLid(0);
            u.state = 'leaving';
            u.timer = 1.6;
          }
          break;
        case 'leaving':
          box.setAway(1 - u.timer / 1.6);
          if (u.timer <= 0) {
            u.state = 'away';
            u.timer = 2.5;
          }
          break;
        case 'away':
          if (u.timer <= 0) this.land(u);
          break;
        case 'arriving':
          box.setAway(Math.max(0, u.timer / 1.2));
          if (u.timer <= 0) {
            box.setAway(0);
            u.state = 'idle';
            this.hooks.onMoved(u);
          }
          break;
        default:
          break;
      }
    }
  }

  private finishRoll(u: BoxUnit): void {
    const box = u.prop;
    // Only leave if there is somewhere reachable to go.
    const elsewhere = this.freePads(u).length > 0;
    if (u.rolls >= u.limit && elsewhere) {
      u.state = 'bear';
      u.timer = 2.4;
      u.buyer = false;
      box.showBear(true);
      box.setGlow(0xff3a2a, 0.6);
      this.hooks.onBear(u);
      return;
    }
    const owned = this.hooks.owned();
    const weights = boxWeights(owned);
    const id = BOX_POOL[this.rng.weighted(weights)];
    u.offer = id;
    u.state = 'offer';
    u.timer = OFFER_TIME;
    box.showWeapon(id);
    const rarity = getWeapon(id).rarity;
    box.setGlow(RARITY_INFO[rarity].color, rarity === 'legendary' ? 1 : 0.7);
    this.hooks.onReveal(u, id);
  }

  /** Pads this box could move to: reachable, and not under another box. */
  private freePads(u: BoxUnit): number[] {
    const taken = new Set(this.units.filter((o) => o !== u && o.enabled && o.state !== 'away').map((o) => o.prop.padIndex));
    const open = this.hooks.openZones();
    return this.pads
      .map((_, k) => k)
      .filter((k) => k !== u.prop.padIndex && !taken.has(k) && open.has(this.pads[k].zone));
  }

  private land(u: BoxUnit): void {
    const options = this.freePads(u);
    const pad = options.length ? options[this.rng.int(options.length)] : u.prop.padIndex;
    u.prop.moveTo(this.pads[pad], pad, this.hooks.probe());
    u.prop.group.visible = true;
    u.prop.setGlow(IDLE_GLOW, 0);
    u.prop.setRise(0);
    u.rolls = 0;
    u.limit = this.newLimit();
    u.state = 'arriving';
    u.timer = 1.2;
  }
}
