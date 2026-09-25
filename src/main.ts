/**
 * Boot, menus and the frame loop.
 */

import './style.css';
import { audio } from './core/audio.ts';
import { DEFAULT_QUALITY, QUALITY_PRESETS, type RetroQuality } from './core/retro.ts';
import { Game, type GameState, type RunStats } from './game/game.ts';
import { CHAPTERS, UNLOCK_ROUND } from './game/story.ts';
import { isUnlocked, loadProgress, nextMap, previousMap, recordRun, saveProgress } from './game/progress.ts';
import { MAPS, MAP_ORDER } from './world/maps.ts';
import type { MapId } from './world/mapdata.ts';

const SETTINGS_KEY = 'rza.settings.v2';
/** v1 predates the colour-correct renderer; its quality pick is not carried over. */
const LEGACY_SETTINGS_KEY = 'rza.settings.v1';

type Settings = {
  quality: keyof typeof QUALITY_PRESETS;
  sensitivity: number;
  volume: number;
  invertY: boolean;
  fov: number;
  brightness: number;
};

const DEFAULTS: Settings = {
  quality: DEFAULT_QUALITY,
  sensitivity: 22,
  volume: 70,
  invertY: false,
  fov: 80,
  brightness: 50,
};

/** Maps the 0..100 brightness slider to a linear exposure, 50 being neutral. */
function exposureFor(brightness: number): number {
  return Math.pow(2, (brightness - 50) / 30);
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
      if (!QUALITY_PRESETS[s.quality]) s.quality = DEFAULT_QUALITY;
      return s;
    }
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Partial<Settings>;
      return {
        ...DEFAULTS,
        sensitivity: old.sensitivity ?? DEFAULTS.sensitivity,
        volume: old.volume ?? DEFAULTS.volume,
        invertY: old.invertY ?? DEFAULTS.invertY,
        fov: old.fov ?? DEFAULTS.fov,
      };
    }
    return { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private browsing; settings just will not persist */
  }
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function statsRows(rows: [string, string][]): string {
  return rows.map(([k, v]) => `<div><span class="k">${k}</span><span class="r">${v}</span></div>`).join('');
}

function boot(): void {
  const canvas = el<HTMLCanvasElement>('view');
  const settings = loadSettings();

  let game: Game;
  try {
    game = new Game(canvas, QUALITY_PRESETS[settings.quality] as RetroQuality);
  } catch (err) {
    el('boot').innerHTML =
      '<div class="menu-inner"><div class="boot-text" style="animation:none">' +
      'WEBGL UNAVAILABLE &mdash; THIS GAME NEEDS HARDWARE 3D.<br><br>' +
      `<small style="opacity:.6">${String(err)}</small></div></div>`;
    return;
  }

  const menu = el('menu');
  const pause = el('pause');
  const gameover = el('gameover');
  const victory = el('victory');
  const bootScreen = el('boot');
  const clickToPlay = el('click-to-play');

  const settingsOverlay = el('settings');

  const panels = {
    main: el('menu-main'),
    howto: el('menu-howto'),
    maps: el('menu-maps'),
    brief: el('menu-brief'),
  };

  const showPanel = (name: keyof typeof panels): void => {
    for (const [key, node] of Object.entries(panels)) {
      node.classList.toggle('hidden', key !== name);
    }
  };

  /* ------------------------------------------------------------ settings */

  const qualitySel = el<HTMLSelectElement>('opt-quality');
  const sensInput = el<HTMLInputElement>('opt-sens');
  const volInput = el<HTMLInputElement>('opt-vol');
  const invertInput = el<HTMLInputElement>('opt-invert');
  const fovInput = el<HTMLInputElement>('opt-fov');
  const brightInput = el<HTMLInputElement>('opt-bright');

  const applySettings = (): void => {
    game.setQuality(QUALITY_PRESETS[settings.quality] as RetroQuality);
    game.input.sensitivity = settings.sensitivity / 10000;
    game.input.invertY = settings.invertY;
    game.setFov(settings.fov);
    game.retro.setExposure(exposureFor(settings.brightness));
    audio.setVolume(settings.volume / 100);
    el('val-sens').textContent = (settings.sensitivity / 10).toFixed(1);
    el('val-vol').textContent = String(settings.volume);
    el('val-fov').textContent = String(settings.fov);
    el('val-bright').textContent = String(settings.brightness);
    qualitySel.value = settings.quality;
    sensInput.value = String(settings.sensitivity);
    volInput.value = String(settings.volume);
    invertInput.checked = settings.invertY;
    fovInput.value = String(settings.fov);
    brightInput.value = String(settings.brightness);
    saveSettings(settings);
  };

  qualitySel.addEventListener('change', () => {
    settings.quality = qualitySel.value as Settings['quality'];
    applySettings();
  });
  sensInput.addEventListener('input', () => {
    settings.sensitivity = Number(sensInput.value);
    applySettings();
  });
  volInput.addEventListener('input', () => {
    settings.volume = Number(volInput.value);
    applySettings();
  });
  invertInput.addEventListener('change', () => {
    settings.invertY = invertInput.checked;
    applySettings();
  });
  fovInput.addEventListener('input', () => {
    settings.fov = Number(fovInput.value);
    applySettings();
  });
  brightInput.addEventListener('input', () => {
    settings.brightness = Number(brightInput.value);
    applySettings();
  });

  applySettings();

  /* --------------------------------------------------------------- state */

  const progress = loadProgress();
  // The chapter to offer first: the furthest one unlocked that has not been escaped yet.
  let selected: MapId = MAP_ORDER.find((m) => isUnlocked(progress, m) && !progress.records[m]?.escaped && m !== MAP_ORDER[0])
    ?? MAP_ORDER.filter((m) => isUnlocked(progress, m)).pop()
    ?? MAP_ORDER[0];

  const renderBest = (): void => {
    const escaped = MAP_ORDER.filter((m) => progress.records[m]?.escaped).length;
    const bestRound = Math.max(0, ...MAP_ORDER.map((m) => progress.records[m]?.bestRound ?? 0));
    el('best').textContent = bestRound
      ? `CHAPTERS ESCAPED ${escaped}/${MAP_ORDER.length}  ·  BEST ROUND ${bestRound}`
      : 'NO RUNS RECORDED';
  };
  renderBest();

  /* -------------------------------------------------------- chapter select */

  const renderMapCards = (): void => {
    const cards = MAP_ORDER.map((m) => {
      const c = CHAPTERS[m];
      const rec = progress.records[m];
      const open = isUnlocked(progress, m);
      const card = document.createElement('button');
      card.className = 'card';
      card.classList.toggle('locked', !open);
      card.classList.toggle('done', Boolean(rec?.escaped));
      const prev = previousMap(m);
      const status = !open && prev
        ? `LOCKED \u2014 ESCAPE ${MAPS[prev].name} OR REACH ROUND ${UNLOCK_ROUND} THERE`
        : rec?.bestRound
          ? `BEST ROUND ${rec.bestRound}${rec.escaped ? `  \u00b7  OUT BY ROUND ${rec.fastestEscape}` : ''}`
          : 'NOT YET PLAYED';
      card.innerHTML =
        `<span class="num">CHAPTER ${c.number}</span>` +
        `<span class="name">${MAPS[m].name}</span>` +
        `<span class="ttl">${c.title}</span>` +
        `<span class="blurb">${open ? c.blurb : '???'}</span>` +
        `<span class="status">${status}</span>`;
      card.addEventListener('click', () => {
        if (!open) {
          audio.deny();
          return;
        }
        openBrief(m);
      });
      return card;
    });
    el('map-cards').replaceChildren(...cards);
  };

  const openMaps = (): void => {
    renderMapCards();
    showPanel('maps');
    const first = el('map-cards').querySelector<HTMLButtonElement>('.card:not(.locked)');
    first?.focus();
  };

  const openBrief = (m: MapId): void => {
    selected = m;
    const c = CHAPTERS[m];
    el('brief-chapter').textContent = `CHAPTER ${c.number}  \u00b7  ${MAPS[m].name}`;
    el('brief-title').textContent = c.title;
    el('brief-text').innerHTML = c.briefing.map((para) => `<p>${para}</p>`).join('');
    el('brief-steps').innerHTML = [
      '<b>RESTORE THE POWER</b>',
      `FIND THE <b>${c.parts.join('</b>, THE <b>')}</b>`,
      `BUILD THE <b>${c.device}</b> AT THE WORKBENCH`,
      `SURVIVE <span class="boss">${c.bossName}</span> &mdash; ${c.bossNote}`,
      `ESCAPE THROUGH <b>${c.exit}</b>`,
    ].map((li) => `<li>${li}</li>`).join('');
    showPanel('brief');
    el('btn-begin').focus();
  };

  /** Records a finished run, returning the note to show if it opened a new map. */
  const record = (stats: RunStats): string | null => {
    const res = recordRun(progress, stats.map, {
      round: stats.round, kills: stats.kills, points: stats.points, escaped: stats.escaped,
    });
    saveProgress(progress);
    renderBest();
    return res.unlocked ? `NEW CHAPTER UNLOCKED: ${MAPS[res.unlocked].name}` : null;
  };

  const showUnlock = (id: string, note: string | null): void => {
    const node = el(id);
    node.classList.toggle('hidden', !note);
    node.textContent = note ?? '';
  };

  /* ------------------------------------------------------------ settings screen */

  // Opened from the main menu or from the pause menu; BACK or Esc returns there.
  let settingsFrom: 'menu' | 'pause' | null = null;

  const openSettings = (from: 'menu' | 'pause'): void => {
    settingsFrom = from;
    menu.classList.add('hidden');
    pause.classList.add('hidden');
    settingsOverlay.classList.toggle('see-through', from === 'pause');
    settingsOverlay.classList.remove('hidden');
    qualitySel.focus();
  };

  const closeSettings = (): void => {
    const from = settingsFrom;
    settingsFrom = null;
    settingsOverlay.classList.add('hidden');
    if (from === 'pause' && game.state === 'paused') {
      pause.classList.remove('hidden');
      el('btn-pause-settings').focus();
    } else if (game.state === 'menu') {
      menu.classList.remove('hidden');
      showPanel('main');
      el('btn-settings').focus();
    }
  };

  game.onStateChange = (s: GameState) => {
    // Leaving the paused state (or dying) takes the settings screen with it.
    if (settingsFrom === 'pause' && s !== 'paused') {
      settingsFrom = null;
      settingsOverlay.classList.add('hidden');
    }
    menu.classList.toggle('hidden', s !== 'menu' || settingsFrom !== null);
    pause.classList.toggle('hidden', s !== 'paused' || settingsFrom !== null);
    gameover.classList.toggle('hidden', s !== 'gameover');
    victory.classList.toggle('hidden', s !== 'victory');
    clickToPlay.classList.toggle('hidden', !(s === 'playing' && !game.input.locked));
    if (s === 'paused') {
      el('pause-stats').innerHTML = statsRows([
        ['ROUND', String(game.stats.round)],
        ['KILLS', String(game.stats.kills)],
        ['POINTS', String(game.player.points)],
        ['LOCATION', game.currentZoneName],
        ['OBJECTIVE', game.quest.objectives().find((o) => !o.done)?.text ?? '\u2014'],
      ]);
    }
  };

  game.onGameOver = (stats: RunStats) => {
    const before = progress.records[stats.map]?.bestRound ?? 0;
    const note = record(stats);
    const best = progress.records[stats.map]?.bestRound ?? stats.round;
    el('go-stats').innerHTML = statsRows([
      ['CHAPTER', `${CHAPTERS[stats.map].number}: ${CHAPTERS[stats.map].title}`],
      ['SURVIVED TO ROUND', String(stats.round)],
      ['KILLS', String(stats.kills)],
      ['HEADSHOTS', String(stats.headshots)],
      ['POINTS EARNED', String(stats.points)],
      ['TIME', fmtTime(stats.seconds)],
      ['BEST ROUND HERE', String(best)],
    ]) + (stats.round > before ? '<div style="color:#ffc84d;margin-top:10px">NEW PERSONAL BEST</div>' : '');
    showUnlock('go-unlock', note);
  };

  game.onVictory = (stats: RunStats) => {
    const note = record(stats);
    const c = CHAPTERS[stats.map];
    const last = !nextMap(stats.map);
    el('win-chapter').textContent = `CHAPTER ${c.number}: ${c.title}  \u00b7  COMPLETE`;
    el('win-story').innerHTML = c.ending.map((para) => `<p>${para}</p>`).join('') +
      (last ? '<p style="color:#ffc84d;letter-spacing:.3em;text-align:center">THE END &mdash; THANKS FOR PLAYING</p>' : '');
    el('win-stats').innerHTML = statsRows([
      ['ESCAPED ON ROUND', String(stats.round)],
      ['KILLS', String(stats.kills)],
      ['HEADSHOTS', String(stats.headshots)],
      ['POINTS EARNED', String(stats.points)],
      ['TIME', fmtTime(stats.seconds)],
    ]);
    showUnlock('win-unlock', note);
    const next = nextMap(stats.map);
    el('btn-next').classList.toggle('hidden', !next || !isUnlocked(progress, next));
    if (next) selected = next;
  };

  const startRun = async (m: MapId = selected): Promise<void> => {
    selected = m;
    await audio.resume();
    game.newRun(undefined, m);
    game.input.requestLock();
  };

  el('btn-play').addEventListener('click', () => openMaps());
  el('btn-begin').addEventListener('click', () => void startRun(selected));
  el('btn-brief-back').addEventListener('click', () => openMaps());
  el('btn-howto').addEventListener('click', () => showPanel('howto'));
  el('btn-settings').addEventListener('click', () => openSettings('menu'));
  el('btn-pause-settings').addEventListener('click', () => openSettings('pause'));
  el('btn-settings-back').addEventListener('click', () => closeSettings());
  for (const back of document.querySelectorAll('.btn.back')) {
    back.addEventListener('click', () => showPanel('main'));
  }
  el('btn-resume').addEventListener('click', () => {
    game.resumeGame();
    game.input.requestLock();
  });
  el('btn-quit').addEventListener('click', () => {
    game.abandon();
    showPanel('main');
  });
  el('btn-again').addEventListener('click', () => void startRun(game.mapId));
  el('btn-menu').addEventListener('click', () => {
    game.abandon();
    showPanel('main');
  });
  el('btn-go-maps').addEventListener('click', () => {
    game.abandon();
    openMaps();
  });
  el('btn-next').addEventListener('click', () => {
    const next = nextMap(game.mapId);
    if (!next) return;
    game.abandon();
    openBrief(next);
  });
  el('btn-win-maps').addEventListener('click', () => {
    game.abandon();
    openMaps();
  });
  el('btn-win-menu').addEventListener('click', () => {
    game.abandon();
    showPanel('main');
  });
  clickToPlay.addEventListener('click', () => game.input.requestLock());

  canvas.addEventListener('click', () => {
    if (game.state === 'playing' && !game.input.locked) game.input.requestLock();
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    clickToPlay.classList.toggle('hidden', !(game.state === 'playing' && !locked));
    // Losing the pointer while alive means the player tabbed away: pause.
    if (!locked && game.state === 'playing') game.pause();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      // Esc backs out one level: settings, then the pause menu, then into play.
      if (settingsFrom) closeSettings();
      else if (game.state === 'playing') game.pause();
      else if (game.state === 'paused') {
        game.resumeGame();
        game.input.requestLock();
      }
    }
    if (e.code === 'KeyM' && game.state !== 'menu') {
      audio.setMuted(!audio.muted);
    }
  });

  window.addEventListener('resize', () => game.resize());

  /* ---------------------------------------------------------------- loop */

  let last = performance.now();
  let accumulator = 0;
  const STEP = 1 / 120;

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    // Clamp so an alt-tab does not teleport the horde into the player's face.
    const elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;

    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= STEP && steps < 8) {
      game.update(STEP);
      accumulator -= STEP;
      steps++;
    }
    if (steps === 8) accumulator = 0;

    game.render();
  };

  // Debug handle. The headless smoke test drives the game through this.
  (window as unknown as { __RZA: unknown }).__RZA = { game, audio, settings, progress };

  bootScreen.classList.add('hidden');
  game.onStateChange('menu');
  game.state = 'menu';
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
