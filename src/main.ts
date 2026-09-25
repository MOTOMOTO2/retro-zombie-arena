/**
 * Boot, menus and the frame loop.
 */

import './style.css';
import { audio } from './core/audio.ts';
import { QUALITY_PRESETS, type RetroQuality } from './core/retro.ts';
import { Game, type GameState, type RunStats } from './game/game.ts';

const SETTINGS_KEY = 'rza.settings.v1';
const BEST_KEY = 'rza.best.v1';

type Settings = {
  quality: keyof typeof QUALITY_PRESETS;
  sensitivity: number;
  volume: number;
  invertY: boolean;
  fov: number;
};

const DEFAULTS: Settings = {
  quality: 'dos',
  sensitivity: 22,
  volume: 70,
  invertY: false,
  fov: 80,
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
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

type Best = { round: number; kills: number; points: number };

function loadBest(): Best {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (raw) return JSON.parse(raw) as Best;
  } catch {
    /* ignore */
  }
  return { round: 0, kills: 0, points: 0 };
}

function saveBest(b: Best): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* ignore */
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
  const bootScreen = el('boot');
  const clickToPlay = el('click-to-play');

  const panels = {
    main: el('menu-main'),
    howto: el('menu-howto'),
    settings: el('menu-settings'),
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

  const applySettings = (): void => {
    game.setQuality(QUALITY_PRESETS[settings.quality] as RetroQuality);
    game.input.sensitivity = settings.sensitivity / 10000;
    game.input.invertY = settings.invertY;
    game.setFov(settings.fov);
    audio.setVolume(settings.volume / 100);
    el('val-sens').textContent = (settings.sensitivity / 10).toFixed(1);
    el('val-vol').textContent = String(settings.volume);
    el('val-fov').textContent = String(settings.fov);
    qualitySel.value = settings.quality;
    sensInput.value = String(settings.sensitivity);
    volInput.value = String(settings.volume);
    invertInput.checked = settings.invertY;
    fovInput.value = String(settings.fov);
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

  applySettings();

  /* --------------------------------------------------------------- state */

  const best = loadBest();
  const renderBest = (): void => {
    el('best').textContent = best.round
      ? `BEST: ROUND ${best.round}  ·  ${best.kills} KILLS  ·  ${best.points} PTS`
      : 'NO RUNS RECORDED';
  };
  renderBest();

  game.onStateChange = (s: GameState) => {
    menu.classList.toggle('hidden', s !== 'menu');
    pause.classList.toggle('hidden', s !== 'paused');
    gameover.classList.toggle('hidden', s !== 'gameover');
    clickToPlay.classList.toggle('hidden', !(s === 'playing' && !game.input.locked));
    if (s === 'paused') {
      el('pause-stats').innerHTML = statsRows([
        ['ROUND', String(game.stats.round)],
        ['KILLS', String(game.stats.kills)],
        ['POINTS', String(game.player.points)],
        ['LOCATION', game.currentZoneName],
      ]);
    }
  };

  game.onGameOver = (stats: RunStats) => {
    const record =
      stats.round > best.round ||
      (stats.round === best.round && stats.points > best.points);
    if (record) {
      best.round = stats.round;
      best.kills = stats.kills;
      best.points = stats.points;
      saveBest(best);
      renderBest();
    }
    el('go-stats').innerHTML = statsRows([
      ['SURVIVED TO ROUND', String(stats.round)],
      ['KILLS', String(stats.kills)],
      ['HEADSHOTS', String(stats.headshots)],
      ['POINTS EARNED', String(stats.points)],
      ['TIME', fmtTime(stats.seconds)],
      ['BEST ROUND', String(best.round)],
    ]) + (record ? '<div style="color:#ffc84d;margin-top:10px">NEW PERSONAL BEST</div>' : '');
  };

  const startRun = async (): Promise<void> => {
    await audio.resume();
    game.newRun();
    game.input.requestLock();
  };

  el('btn-play').addEventListener('click', () => void startRun());
  el('btn-howto').addEventListener('click', () => showPanel('howto'));
  el('btn-settings').addEventListener('click', () => showPanel('settings'));
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
  el('btn-again').addEventListener('click', () => void startRun());
  el('btn-menu').addEventListener('click', () => {
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
      if (game.state === 'playing') game.pause();
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
