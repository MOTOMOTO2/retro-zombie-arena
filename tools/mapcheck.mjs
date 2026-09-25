import { buildTileMap, mapToAscii, MAP_W, BARRICADES, DOORS, WALL_BUYS, PERKS, BOX_PADS, POWER_SWITCH, T_WALL, T_FLOOR } from '../src/world/mapdata.ts';
const m = buildTileMap();
console.log(mapToAscii(m));
const bad = [];
for (const b of BARRICADES) {
  const inside = m[(b.tz - b.dz) * MAP_W + (b.tx - b.dx)];
  if (inside !== T_FLOOR) bad.push(`barricade ${b.id} not adjacent to floor (inside=${inside})`);
}
for (const w of WALL_BUYS) {
  const nx = Math.round(Math.sin(w.facing)), nz = Math.round(Math.cos(w.facing));
  if (m[w.tz * MAP_W + w.tx] !== T_FLOOR) bad.push(`wallbuy ${w.weapon}@${w.tx},${w.tz} not on floor`);
  const behind = m[(w.tz - nz) * MAP_W + (w.tx - nx)];
  if (behind !== T_WALL) bad.push(`wallbuy ${w.weapon}@${w.tx},${w.tz} has no wall behind it (got ${behind})`);
}
for (const p of [...PERKS, ...BOX_PADS.map(b=>({perk:'box',...b})), {perk:'power',...POWER_SWITCH}]) {
  if (m[p.tz * MAP_W + p.tx] !== T_FLOOR) bad.push(`prop ${p.perk}@${p.tx},${p.tz} tile=${m[p.tz*MAP_W+p.tx]} (want floor)`);
}
for (const d of DOORS) {
  // a door must have floor on both sides along its normal
  const n = d.axis === 'z' ? [1,0] : [0,1];
  const a = m[(d.rect.z - n[1]) * MAP_W + (d.rect.x - n[0])];
  const b = m[(d.rect.z + n[1]*d.rect.h) * MAP_W + (d.rect.x + n[0]*d.rect.w)];
  if (a !== T_FLOOR || b !== T_FLOOR) bad.push(`door ${d.id} sides a=${a} b=${b} (want 1/1)`);
}
console.log(bad.length ? 'PROBLEMS:\n' + bad.join('\n') : 'ALL PLACEMENT CHECKS PASS');
