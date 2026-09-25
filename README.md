# RETRO ZOMBIE ARENA

An arcade wave-survival FPS that runs in the browser, dressed in the graphics of
the late-90s / early-2000s: a 240p internal framebuffer, an 8-to-14-level colour
palette with ordered dithering, scanlines, chunky nearest-neighbour textures,
baked vertex lighting and low-poly box-stack monsters.

It borrows its structure from *Call of Duty: Zombies* — points for hits and
kills, doors you buy your way through, wall guns, a roaming mystery box, perk
machines behind a generator, Pack-a-Punch, power-up drops, boardable windows and
an endless round curve — and its feel from *Doom*: no reload-to-cover, no
regenerating cover system, just strafing backwards through a crowd with a
shotgun while the walls close in.

**Everything is generated at runtime.** There are no images, models, fonts or
audio files in this repository. Textures are painted onto canvases, models are
stacks of boxes, lighting is baked into vertex colours at load, and every sound
is synthesised with the Web Audio API.

> **ST. MERCY ASYLUM** — six rooms, seven doors, one way out: there isn't one.

| | |
|---|---|
| ![Title screen](docs/01-title.png) | ![Admissions, with the horde inside](docs/02-lobby.png) |
| ![The chapel](docs/03-chapel.png) | ![The furnace hall](docs/04-furnace.png) |

*(Screenshots are captured by `tools/diag.mjs` in headless Chromium with
software WebGL, so they are exactly what the game draws.)*

## Running it

Requires Node 20+ (developed on Node 24).

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

For a production build:

```bash
npm run build      # type-checks, then bundles to dist/
npm run preview    # serves dist/ at http://127.0.0.1:4173
```

`dist/` is a plain static site with relative asset paths, so it can be dropped
onto GitHub Pages, Netlify, S3 or any static host as-is. It will **not** run
from a `file://` URL — ES modules need a real HTTP origin. Use `npm run preview`
or any static server.

A WebGL-capable browser is required. The game is mouse-and-keyboard only and
uses Pointer Lock, so it needs a desktop browser.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `Shift` | Sprint (drains stamina) |
| `Space` | Jump |
| `R` | Reload |
| `F` / `E` | Buy, use, or **hold** to re-board a window |
| `V` | Knife |
| `G` | Grenade (once you have bought some) |
| `1` `2` / `Q` / mouse wheel | Swap weapon |
| `Tab` | Map |
| `M` | Mute |
| `Esc` | Pause |

## How a run works

You start in **ADMISSIONS** with a pistol, 500 points and four boarded windows.

- **Points.** 10 per hit, 60 per kill, 100 for a headshot kill, 130 for a knife
  kill, 10 per board you nail back on, plus a survival bonus at the end of each
  round. (That end-of-round bonus is the one thing the source material does not
  do — it is there to keep the arcade pacing moving.)
- **Doors** cost 750–1500 and open the ring of rooms. Zombies only spawn from
  windows in rooms you have opened, so every door you buy is also a decision
  about where they come from.
- **Wall guns** are bought once at full price, then refilled at half.
- **The mystery box** costs 950, gives you a random weapon from a weighted pool,
  and packs up and moves somewhere else after four to nine pulls.
- **The generator** is in the north-east corner. Until you flip it, the perk
  machines and Pack-a-Punch are dead metal.
- **Perks** (max four): Quick Revive, Juggernog, Speed Cola, Double Tap,
  Stamin-Up. Only Quick Revive works without power.
- **Pack-a-Punch** costs 5000 and roughly doubles a weapon's damage.
- **Power-ups** drop from kills: Max Ammo, Insta-Kill, Double Points, Nuke,
  Carpenter.
- **Every fifth round** is a hellhound round: fewer enemies, much faster, and the
  round always ends in max ammo.

Enemy health is flat-ish for nine rounds (150 → 950), then compounds at 10% per
round, so eventually nothing you own will kill in one magazine. Runners appear
from round 4, brutes from round 8. Your best round is saved to `localStorage`.

## Graphics settings

Four presets in the settings menu, from **1996** (320×200, 8 colour levels per
channel, heavy dither) through **1999** (240p, the default) and **2003** (360p)
to **MODERN** (540p, light post-processing). The 3D scene always renders into a
small offscreen buffer and is point-sampled up to the window, so the pixels stay
square no matter how large your monitor is. FOV, sensitivity, Y-invert and
volume are also adjustable and persist.

## Project layout

```
src/
  main.ts              boot, menus, settings, frame loop
  style.css            HUD and menu styling (CRT treatment)
  core/
    retro.ts           low-res render target + palette/dither/scanline shader
    input.ts           keyboard + mouse + pointer lock
    audio.ts           procedural Web Audio: guns, groans, jingles, drones
    rng.ts             seeded mulberry32
  gfx/
    textures.ts        every texture, painted onto a canvas at 32–128px
    models.ts          box-stack weapon/zombie/hound models + particle field
  world/
    mapdata.ts         the arena as data: rooms, corridors, doors, windows
    grid.ts            circle/tile collision, DDA raycasting, BFS flow field
    build.ts           merges the tile map into geometry, bakes vertex lighting
    props.ts           doors, windows, perk machines, box, Pack-a-Punch, clutter
  game/
    rules.ts           round curve, scoring, perks, power-ups (pure)
    weapons.ts         the weapon table (pure)
    player.ts          movement, health, wallet, two-slot inventory (pure)
    enemy.ts           enemy state machine, animation, pooling
    viewmodel.ts       first-person weapon rendering and animation
    hud.ts             DOM HUD and minimap
    game.ts            the loop that ties it together
test/
  logic.test.ts        33 unit tests over the pure half of the game
  browser-smoke.mjs    52 checks driving the real game in headless Chromium
tools/
  mapcheck.mjs         prints the arena as ASCII and validates prop placement
  diag.mjs             screenshots the built game from fixed camera positions
docs/                  the screenshots above
```

## How it is put together

A few decisions are worth calling out, because they are what make the look and
the horde possible at the same time:

**The level is one mesh per material, lit once.** `build.ts` walks the tile map,
emits only the wall faces that actually face open floor, merges them per texture,
then runs a CPU lighting pass that writes the result into vertex colours. At
runtime the scene ambient is set to exactly `π`, which cancels three.js's Lambert
`1/π` term, so a surface with a baked colour of 1.0 renders at its full texture
value. This is how shooters of the era shipped, it costs nothing per frame, and
it leaves the whole GPU budget for enemies.

**Pathing is a flow field, not per-enemy A\*.** A breadth-first search from the
player's tile is rebuilt about seven times a second over ~1900 cells. Every
zombie then reads one lookup per frame, steers toward the centre of the next
tile, and gets pushed apart by a separation pass. A whole horde routes perfectly
and identically, which is exactly what makes training them in a circle work.

**The first-person weapon renders in its own scene** after a depth clear, which
is the standard trick for keeping a long barrel from poking through walls.

**Nothing allocates in the hot path.** Enemies, tracers, decals, particles and
power-up drops are all pooled and built once in the constructor.

## Verification

```bash
npm run typecheck     # tsc --noEmit, strict, erasableSyntaxOnly
npm test              # 33 unit tests (node:test, runs .ts directly)
npm run map           # prints the arena and validates every prop placement
npm run build         # type-check + bundle
npm run test:browser  # builds, then runs 52 checks in real headless Chromium
```

`npm test` covers the pure half: that the arena is fully connected once every
door is bought and fully sealed before that, that every window, wall gun, perk
machine and pad sits on legal geometry, that collision ejects a body out of a
wall rather than through it, that the flow field strictly descends to its goal,
and that the round curve never gets easier.

`npm run test:browser` is the one that matters for "does it actually work". It
builds, serves `dist/`, opens it in headless Chromium with software WebGL, and
drives the real game object. It reads the low-resolution framebuffer back and
asserts the world rasterised with a real tonal range; runs 45 seconds of round 1
and checks that enemies spawn, tear boards off windows, get inside and hurt an
idle player; buys a door and confirms the tile became walkable; buys a wall gun,
a perk, Pack-a-Punch and a mystery box pull; applies power-ups; holds the
trigger down on a line of zombies and checks that ammo drains, points accrue,
headshots register, reloads refill, an empty gun stays empty and a wall stops a
bullet; clears a round and checks the counter advanced; pauses and resumes;
kills the player and checks the run reports stats — then asserts no console or
page errors throughout.

It needs Chromium once: `npx playwright install chromium`.

`tools/diag.mjs` writes screenshots to `tools/shots/` from fixed positions around
the arena along with framebuffer brightness statistics. It is how the lighting
was tuned, and it is the fastest way to see whether a rendering change made
things better or worse.

## Assumptions made

This was built from a one-line brief, so a few things were decided rather than
asked:

- **Web / TypeScript / three.js**, because "runs anywhere by opening a link" is
  worth more for a game like this than native performance, and because it makes
  the whole thing verifiable headlessly.
- **Single player only.** Co-op is the other half of the source material, but it
  needs netcode, and the brief said arcade.
- **Downs are final.** There is no bleed-out-and-self-revive; a down ends the
  run. Quick Revive instead speeds up health regeneration.
- **A survival bonus at the end of each round**, which the source material does
  not have, to keep early rounds from dragging.
- **Room dressing has no collision.** Pews, desks, crates and the boiler are
  there to give each room a silhouette; you and the horde walk through them.
  Solid clutter would need per-prop collision and would turn the arena into a
  snag-fest, which is the opposite of arcade.
- **No gore beyond blood particles and decals** — bodies crumple and sink rather
  than dismembering, other than the gib-on-overkill case.

## Licence

No licence chosen; the brief did not specify one. All assets are generated by
the code in this repository, so there is nothing third-party to attribute beyond
[three.js](https://threejs.org/) (MIT).
