/**
 * What each kind of room looks like: wall finish above and below the dado
 * rail, floor, ceiling, the colour and style of its lamps, the bounce light
 * that fills its shadows, and the fog it fades into.
 */

import * as THREE from 'three';
import { textures } from '../gfx/textures.ts';
import type { ThemeId } from './mapdata.ts';

export type LampStyle = 'fluorescent' | 'bulb' | 'cage';

export type ThemeLook = {
  upper: THREE.Texture;
  /** Wainscot below the dado rail, or null for a single finish floor to ceiling. */
  lower: THREE.Texture | null;
  /** Height of the dado rail in world units. */
  dado: number;
  /** Colour of the skirting board and dado rail. */
  trim: number;
  floor: THREE.Texture;
  ceiling: THREE.Texture;
  light: number;
  lampStyle: LampStyle;
  lampIntensity: number;
  /** Tiles between lamps. */
  lampSpacing: number;
  /** Bounce light that fills the shadows, as a colour and a level. */
  ambient: number;
  ambientLevel: number;
  fog: number;
};

export type LookId = ThemeId | 'corridor';

let cache: Record<LookId, ThemeLook> | null = null;

export function looks(): Record<LookId, ThemeLook> {
  if (cache) return cache;
  const t = textures();
  cache = {
    admissions: {
      upper: t.plasterSick, lower: t.tileGreen, dado: 3.2, trim: 0x2e2a22,
      floor: t.floorChecker, ceiling: t.ceilAcoustic,
      light: 0xffe2b8, lampStyle: 'fluorescent', lampIntensity: 2.3, lampSpacing: 5,
      ambient: 0x9a8e78, ambientLevel: 0.3, fog: 0x2e2820,
    },
    ward: {
      upper: t.plasterWhite, lower: t.tileBlue, dado: 3.2, trim: 0x26343a,
      floor: t.floorLino, ceiling: t.ceilAcoustic,
      light: 0xdcecff, lampStyle: 'fluorescent', lampIntensity: 2.3, lampSpacing: 5,
      ambient: 0x8098a4, ambientLevel: 0.3, fog: 0x1e272e,
    },
    records: {
      upper: t.wallpaper, lower: t.woodPanel, dado: 3.4, trim: 0x24160c,
      floor: t.floorWood, ceiling: t.ceilWood,
      light: 0xffcf90, lampStyle: 'bulb', lampIntensity: 2.8, lampSpacing: 5,
      ambient: 0x8a6c4c, ambientLevel: 0.31, fog: 0x281c12,
    },
    furnace: {
      upper: t.brickRed, lower: null, dado: 0, trim: 0x1a1410,
      floor: t.floorConcrete, ceiling: t.ceilConcrete,
      light: 0xff8a44, lampStyle: 'cage', lampIntensity: 2.4, lampSpacing: 5,
      ambient: 0x9a5a38, ambientLevel: 0.28, fog: 0x3a1e12,
    },
    chapel: {
      upper: t.stone, lower: t.woodPanel, dado: 2.8, trim: 0x24160c,
      floor: t.floorStone, ceiling: t.ceilWood,
      light: 0xbcd0ff, lampStyle: 'bulb', lampIntensity: 2.2, lampSpacing: 5,
      ambient: 0x6e78a0, ambientLevel: 0.28, fog: 0x1a2036,
    },
    armory: {
      upper: t.metal, lower: t.metalDark, dado: 3.0, trim: 0x1a1c1e,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0xdcec9e, lampStyle: 'cage', lampIntensity: 2.9, lampSpacing: 5,
      ambient: 0x76805e, ambientLevel: 0.36, fog: 0x20241a,
    },
    catacombs: {
      upper: t.brickGrey, lower: null, dado: 0, trim: 0x1a1a1c,
      floor: t.floorDirt, ceiling: t.ceilConcrete,
      light: 0xb8a4ff, lampStyle: 'bulb', lampIntensity: 2.5, lampSpacing: 5,
      ambient: 0x6a6286, ambientLevel: 0.3, fog: 0x1c1832,
    },
    morgue: {
      upper: t.plasterWhite, lower: t.tileWhite, dado: 4.4, trim: 0x34383a,
      floor: t.floorTileWhite, ceiling: t.ceilAcoustic,
      light: 0xc8fff2, lampStyle: 'fluorescent', lampIntensity: 2.2, lampSpacing: 5,
      ambient: 0x7a9898, ambientLevel: 0.28, fog: 0x16242a,
    },
    generator: {
      upper: t.metal, lower: t.hazard, dado: 1.6, trim: 0x161816,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0x8affd8, lampStyle: 'cage', lampIntensity: 2.7, lampSpacing: 5,
      ambient: 0x588a78, ambientLevel: 0.32, fog: 0x0e2624,
    },
    corridor: {
      upper: t.plasterBlue, lower: t.tileGreen, dado: 3.0, trim: 0x2a2a24,
      floor: t.floorConcrete, ceiling: t.ceilConcrete,
      light: 0xe0cca0, lampStyle: 'bulb', lampIntensity: 2.1, lampSpacing: 4,
      ambient: 0x78766c, ambientLevel: 0.26, fog: 0x1c1a1c,
    },
  };
  return cache;
}

/** Moonlight for the scrap of ground outside each window. */
export const MOONLIGHT = new THREE.Color(0.16, 0.2, 0.32);
