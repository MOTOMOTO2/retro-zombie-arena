/**
 * What the HUD costs per frame.
 *
 * Presentation - the HUD, the bars and numbers over the horde, the objective
 * marker and the minimap - is DOM and canvas work, and the frame loop paints it
 * once per drawn frame rather than once per simulation step. This measures what
 * that is worth at a few frame rates, with a real crowd in the room.
 *
 * The thing to watch is not the size of the saving so much as its shape: the
 * redundant painting grows with the number of steps a frame took, which is
 * backwards - a frame that is already late would do the most wasted work.
 *
 * The signal is a fraction of a millisecond and this runs on software WebGL, so
 * the two arrangements are timed in short alternating trials and the median of
 * each is reported. Timing one and then the other picks up drift far bigger
 * than the difference being measured.
 *
 *   npm run hudcost                  round 9 of the asylum
 *   npm run hudcost -- 15 --map=labs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg' };

const mapArg = process.argv.find((a) => a.startsWith('--map='));
const MAP = mapArg ? mapArg.slice(6) : 'asylum';
const ROUND = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 9);

const server = createServer(async (req, res) => {
  try {
    let p = new URL(req.url, 'http://l').pathname;
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p.split('/').filter(Boolean).join('/'));
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404).end('x');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RZA), null, { timeout: 30000 });

const out = await page.evaluate(({ map, round }) => {
  const { game } = window.__RZA;
  // Round nine hits hard enough to kill inside a single step, which would drop
  // the run out of 'playing' and make the rest of the measurement look free.
  // tickHealth leaves anything already over the maximum alone, so this holds.
  const live = () => { game.player.health = 1e9; };

  game.hostPresents = false;
  game.newRun(4242, map);
  game.input.locked = true;
  game.player.award(1e6);
  // Open the map up so the horde can get to the player from every side.
  for (const d of game.props.doors) if (!d.open) game.buyDoor(d);
  game.startRound(round);
  for (let i = 0; i < 4200; i++) { live(); game.update(1 / 120); }
  game.hud.toggleMap(true);
  // Hurt everything standing, so every body in sight carries a health bar.
  game.pool.forEachLive((e) => game.damageEnemy(e, e.health * 0.4, false, false, { x: e.x, y: e.headY, z: e.z }));

  /** Milliseconds a frame of `steps` simulation steps takes, averaged over a short burst. */
  const burst = (steps, onceAFrame, frames) => {
    game.hostPresents = onceAFrame;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < steps; i++) { live(); game.update(1 / 120); }
      if (onceAFrame) game.present(1 / 60);
    }
    return (performance.now() - t0) / frames;
  };

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Warm the JIT on both arrangements before anything is recorded.
  burst(2, true, 60);
  burst(2, false, 60);
  const bars = game.tags.visible.bars;

  const TRIALS = 25;
  const FRAMES = 40;
  const rows = [[120, 1], [60, 2], [30, 4]].map(([fps, steps]) => {
    const a = [];
    const b = [];
    for (let t = 0; t < TRIALS; t++) {
      // Alternate, and swap which goes first, so neither gets the warmer cache.
      if (t % 2) {
        b.push(burst(steps, false, FRAMES));
        a.push(burst(steps, true, FRAMES));
      } else {
        a.push(burst(steps, true, FRAMES));
        b.push(burst(steps, false, FRAMES));
      }
    }
    return { fps, steps, onceAFrame: median(a), perStep: median(b) };
  });
  return { rows, live: game.pool.liveCount, bars, state: game.state };
}, { map: MAP, round: ROUND });

if (out.state !== 'playing') {
  console.error(`\nthe run ended (${out.state}) part-way through, so these timings mean nothing`);
  await browser.close();
  server.close();
  process.exit(1);
}

console.log(
  `\n${MAP}, round ${ROUND}: ${out.live} alive, ${out.bars} health bars on screen, minimap open` +
  '\n(software WebGL, so read these as a ceiling rather than real hardware)\n',
);
console.log('  frame rate   steps/frame   once a frame   per step     saved');
for (const r of out.rows) {
  console.log(
    `  ${String(r.fps).padStart(7)} fps   ${String(r.steps).padStart(11)}   ` +
    `${r.onceAFrame.toFixed(3).padStart(9)} ms   ${r.perStep.toFixed(3).padStart(6)} ms   ` +
    `${(r.perStep - r.onceAFrame).toFixed(3).padStart(6)} ms`,
  );
}
// Both columns are whole frames, simulation included, so the difference is the
// redundant painting on its own - and it should grow with the steps per frame.
const saved = out.rows.map((r) => r.perStep - r.onceAFrame);
console.log(
  `\n  redundant painting, by steps per frame: ${saved.map((v) => `${v.toFixed(3)} ms`).join('  ->  ')}\n`,
);

await browser.close();
server.close();
