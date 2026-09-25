/**
 * Prints a generated asylum as ASCII and validates it.
 *
 *   npm run map            a random seed
 *   npm run map -- 1234    a specific seed
 *   npm run map -- --sweep 500   generate 500 seeds and report any failures
 */
import { MAP_W, generateLayout, mapToAscii, validateLayout } from '../src/world/mapdata.ts';

const args = process.argv.slice(2);

if (args[0] === '--sweep') {
  const n = Number(args[1] ?? 300);
  const t0 = performance.now();
  let bad = 0;
  const rooms = new Map();
  for (let seed = 1; seed <= n; seed++) {
    try {
      const L = generateLayout(seed);
      const errs = validateLayout(L);
      rooms.set(L.zones.length, (rooms.get(L.zones.length) ?? 0) + 1);
      if (errs.length) {
        bad++;
        console.log(`seed ${seed}: ${errs.join('; ')}`);
      }
    } catch (e) {
      bad++;
      console.log(`seed ${seed}: ${e.message}`);
    }
  }
  const ms = (performance.now() - t0) / n;
  console.log(`${n - bad}/${n} seeds valid, ${ms.toFixed(2)} ms per layout`);
  console.log(`room counts: ${[...rooms].sort().map(([k, v]) => `${k} rooms x${v}`).join(', ')}`);
  process.exit(bad ? 1 : 0);
}

const seed = args[0] ? Number(args[0]) : 1 + Math.floor(Math.random() * 999999);
const L = generateLayout(seed);
const grid = mapToAscii(L.tiles).split('\n').map((r) => r.split(''));
const mark = (tx, tz, ch) => {
  grid[tz][tx] = ch;
};
for (const p of L.perks) mark(p.tx, p.tz, 'P');
for (const w of L.wallBuys) mark(w.tx, w.tz, 'W');
L.boxPads.forEach((b, i) => mark(b.tx, b.tz, i === 0 ? '?' : 'b'));
mark(L.powerSwitch.tx, L.powerSwitch.tz, 'S');
mark(L.pack.tx, L.pack.tz, 'K');
mark(L.spawn.tx, L.spawn.tz, '@');
console.log(`seed ${seed}  (${MAP_W} wide)`);
console.log(grid.map((r) => r.join('')).join('\n'));
console.log('\nrooms:');
for (const z of L.zones) {
  const tags = [z.id === L.spawnZone ? 'START' : '', z.id === L.powerZone ? 'POWER' : ''].filter(Boolean).join(' ');
  console.log(`  ${z.name.padEnd(18)} ${z.theme.padEnd(10)} ${z.rect.w}x${z.rect.h}  ${tags}`);
}
console.log(`doors: ${L.doors.map((d) => `${d.label} ${d.cost}`).join(', ')}`);
if (L.openLinks.length) console.log(`open archways: ${L.openLinks.length}`);
const errs = validateLayout(L);
console.log(errs.length ? `PROBLEMS:\n${errs.join('\n')}` : 'ALL PLACEMENT CHECKS PASS');
