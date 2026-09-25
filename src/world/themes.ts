/**
 * What each kind of room looks like: wall finish above and below the dado
 * rail, floor, ceiling, the colour and style of its lamps, the bounce light
 * that fills its shadows, and the fog it fades into.
 */

import * as THREE from 'three';
import { textures } from '../gfx/textures.ts';
import { T_DOOR, T_FLOOR, type CorridorLook, type Layout, type ThemeId, getZone, tileAt, zoneAt } from './mapdata.ts';

/** 'post' is a street lamp standing against a wall, for places with no ceiling. */
export type LampStyle = 'fluorescent' | 'bulb' | 'cage' | 'post';

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
  /** Open to the sky: no ceiling, moonlight, and street lamps on posts. */
  outdoor?: boolean;
};

export type LookId = ThemeId | CorridorLook;

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
    /* ------------------------------------------------ Hollow Creek */
    street: {
      upper: t.facade, lower: null, dado: 0, trim: 0x2a2420,
      floor: t.asphalt, ceiling: t.ceilConcrete,
      light: 0xffc27a, lampStyle: 'post', lampIntensity: 2.8, lampSpacing: 6,
      ambient: 0x56688a, ambientLevel: 0.34, fog: 0x1a2232, outdoor: true,
    },
    square: {
      upper: t.facadeGrey, lower: null, dado: 0, trim: 0x2a2826,
      floor: t.cobble, ceiling: t.ceilConcrete,
      light: 0xffd08a, lampStyle: 'post', lampIntensity: 2.8, lampSpacing: 6,
      ambient: 0x5a6a8a, ambientLevel: 0.34, fog: 0x1a2232, outdoor: true,
    },
    cemetery: {
      upper: t.stone, lower: null, dado: 0, trim: 0x1a1a1c,
      floor: t.grass, ceiling: t.ceilConcrete,
      light: 0xa8c0ff, lampStyle: 'post', lampIntensity: 2.2, lampSpacing: 7,
      ambient: 0x4a5a7a, ambientLevel: 0.32, fog: 0x141c2a, outdoor: true,
    },
    house: {
      upper: t.wallpaper, lower: t.woodPanel, dado: 3.2, trim: 0x24160c,
      floor: t.floorWood, ceiling: t.ceilWood,
      light: 0xffc890, lampStyle: 'bulb', lampIntensity: 2.7, lampSpacing: 5,
      ambient: 0x8a6c4c, ambientLevel: 0.3, fog: 0x281c12,
    },
    store: {
      upper: t.plasterWhite, lower: t.tileGreen, dado: 2.6, trim: 0x2a2a24,
      floor: t.floorChecker, ceiling: t.ceilAcoustic,
      light: 0xf0f4e0, lampStyle: 'fluorescent', lampIntensity: 2.4, lampSpacing: 5,
      ambient: 0x8a8a78, ambientLevel: 0.32, fog: 0x22241e,
    },
    garage: {
      upper: t.brickGrey, lower: null, dado: 0, trim: 0x1a1a1a,
      floor: t.floorConcrete, ceiling: t.ceilMetal,
      light: 0xfff0d0, lampStyle: 'fluorescent', lampIntensity: 2.4, lampSpacing: 5,
      ambient: 0x70706a, ambientLevel: 0.3, fog: 0x1e1e1c,
    },
    /* --------------------------------------------- Vireo Ironworks */
    loading: {
      upper: t.corrugated, lower: t.hazard, dado: 1.6, trim: 0x1a1a18,
      floor: t.floorConcrete, ceiling: t.ceilMetal,
      light: 0xffe8b0, lampStyle: 'cage', lampIntensity: 2.8, lampSpacing: 5,
      ambient: 0x78746a, ambientLevel: 0.32, fog: 0x20201c,
    },
    foundry: {
      upper: t.corrugated, lower: t.brickGrey, dado: 3.0, trim: 0x1a1410,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0xff9a50, lampStyle: 'cage', lampIntensity: 2.8, lampSpacing: 5,
      ambient: 0x9a5a38, ambientLevel: 0.32, fog: 0x2e180a,
    },
    warehouse: {
      upper: t.corrugated, lower: null, dado: 0, trim: 0x1a1a18,
      floor: t.floorConcrete, ceiling: t.ceilMetal,
      light: 0xfff2d0, lampStyle: 'cage', lampIntensity: 2.7, lampSpacing: 5,
      ambient: 0x74726a, ambientLevel: 0.3, fog: 0x1e1e1c,
    },
    yard: {
      upper: t.corrugated, lower: null, dado: 0, trim: 0x1a1a18,
      floor: t.gravel, ceiling: t.ceilMetal,
      light: 0xffe0a0, lampStyle: 'post', lampIntensity: 3.0, lampSpacing: 6,
      ambient: 0x5a6478, ambientLevel: 0.34, fog: 0x1c1e24, outdoor: true,
    },
    /* ------------------------------------------------ Vireo Labs */
    lab: {
      upper: t.labPanel, lower: null, dado: 0, trim: 0x2a3438,
      floor: t.labFloor, ceiling: t.ceilAcoustic,
      light: 0xe8f4ff, lampStyle: 'fluorescent', lampIntensity: 2.6, lampSpacing: 5,
      ambient: 0xa0b0c0, ambientLevel: 0.34, fog: 0x1a2228,
    },
    containment: {
      upper: t.labPanel, lower: t.metalDark, dado: 2.2, trim: 0x1a2020,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0x90ffb0, lampStyle: 'fluorescent', lampIntensity: 2.4, lampSpacing: 5,
      ambient: 0x5a8a6a, ambientLevel: 0.3, fog: 0x0e2014,
    },
    servers: {
      upper: t.metalDark, lower: null, dado: 0, trim: 0x101418,
      floor: t.labFloor, ceiling: t.ceilMetal,
      light: 0x7ab0ff, lampStyle: 'fluorescent', lampIntensity: 2.3, lampSpacing: 5,
      ambient: 0x4a5a8a, ambientLevel: 0.3, fog: 0x0c1428,
    },
    cryo: {
      upper: t.labPanel, lower: t.tileWhite, dado: 2.4, trim: 0x2a3438,
      floor: t.floorTileWhite, ceiling: t.ceilMetal,
      light: 0xb0f0ff, lampStyle: 'fluorescent', lampIntensity: 2.5, lampSpacing: 5,
      ambient: 0x7a9aaa, ambientLevel: 0.32, fog: 0x14242c,
    },
    reactor: {
      upper: t.metal, lower: t.hazard, dado: 1.6, trim: 0x161816,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0x7affd0, lampStyle: 'cage', lampIntensity: 2.7, lampSpacing: 5,
      ambient: 0x588a78, ambientLevel: 0.32, fog: 0x0c2424,
    },
    /* ------------------------------------------ passages, per map */
    alley: {
      upper: t.brickRed, lower: null, dado: 0, trim: 0x1a1410,
      floor: t.asphalt, ceiling: t.ceilConcrete,
      light: 0xffc27a, lampStyle: 'post', lampIntensity: 2.4, lampSpacing: 5,
      ambient: 0x56688a, ambientLevel: 0.32, fog: 0x1a2232, outdoor: true,
    },
    service: {
      upper: t.metalDark, lower: t.hazard, dado: 1.2, trim: 0x161816,
      floor: t.floorGrate, ceiling: t.ceilMetal,
      light: 0xffe0a0, lampStyle: 'cage', lampIntensity: 2.4, lampSpacing: 4,
      ambient: 0x6a6a64, ambientLevel: 0.28, fog: 0x1c1c1a,
    },
    labhall: {
      upper: t.labPanel, lower: t.metalDark, dado: 1.2, trim: 0x2a3438,
      floor: t.labFloor, ceiling: t.ceilAcoustic,
      light: 0xe0f0ff, lampStyle: 'fluorescent', lampIntensity: 2.3, lampSpacing: 4,
      ambient: 0x8a9aaa, ambientLevel: 0.3, fog: 0x161e24,
    },
  };
  return cache;
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

/** Which look a floor or door tile wears. */
export function lookIdAt(layout: Layout, tx: number, tz: number): LookId {
  const z = zoneAt(layout, tx, tz);
  if (z) return getZone(layout, z).theme;
  if (tileAt(layout.tiles, tx, tz) === T_DOOR) {
    // A door set straight between two rooms belongs to them, not to the
    // street outside: it keeps a ceiling if either room has one.
    let inner: LookId | null = null;
    for (const [dx, dz] of DIRS) {
      const nt = tileAt(layout.tiles, tx + dx, tz + dz);
      if (nt !== T_FLOOR && nt !== T_DOOR) continue;
      const nz = zoneAt(layout, tx + dx, tz + dz);
      if (!nz) {
        if (nt === T_FLOOR) return layout.corridorLook;
        continue;
      }
      const theme = getZone(layout, nz).theme;
      if (!inner || looks()[inner].outdoor) inner = theme;
    }
    if (inner) return inner;
  }
  return layout.corridorLook;
}

/** Moonlight for the scrap of ground outside each window. */
export const MOONLIGHT = new THREE.Color(0.16, 0.2, 0.32);
