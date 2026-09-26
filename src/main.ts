/**
 * Boot, menus and the frame loop.
 */

import './style.css';
import { audio } from './core/audio.ts';
import { DEFAULT_KEYS, REBINDABLE, bindable, keyLabel, type Action } from './core/input.ts';
import { DEFAULT_QUALITY, QUALITY_PRESETS, type RetroQuality } from './core/retro.ts';
import { Game, type GameState, type RunStats } from './game/game.ts';
import { CHAPTERS, UNLOCK_ROUND, threatOf, type Chapter, type StepDef } from './game/story.ts';
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
  musicVolume: number;
  invertY: boolean;
  fov: number;
  brightness: number;
  healthBars: boolean;
  damageNumbers: boolean;
  /** Only the actions the player has actually rebound; the rest keep their defaults. */
  keys: Partial<Record<Action, string[]>>;
};

const DEFAULTS: Settings = {
  quality: DEFAULT_QUALITY,
  sensitivity: 22,
  volume: 70,
  musicVolume: 70,
  invertY: false,
  fov: 80,
  brightness: 50,
  healthBars: true,
  damageNumbers: true,
  keys: {},
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

/**
 * Keeps only bindings that still make sense: a known action, real key codes,
 * and nothing the game reserves. Stored settings outlive the build that wrote
 * them, so an action that has since been dropped is simply forgotten.
 */
function cleanKeys(raw: unknown): Partial<Record<Action, string[]>> {
  const out: Partial<Record<Action, string[]>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const { action } of REBINDABLE) {
    const codes = (raw as Record<string, unknown>)[action];
    if (!Array.isArray(codes)) continue;
    const keep = codes.filter((c): c is string => typeof c === 'string' && bindable(c));
    if (keep.length) out[action] = keep;
  }
  return out;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
      if (!QUALITY_PRESETS[s.quality]) s.quality = DEFAULT_QUALITY;
      s.keys = cleanKeys(s.keys);
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
        keys: cleanKeys(old.keys),
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

const THREAT_NAMES = ['LOW', 'RISING', 'HIGH', 'EXTREME'];

/** The chapter's threat as four pips and a word. */
function threatBadge(c: Chapter): string {
  const t = threatOf(c);
  const pips = [0, 1, 2, 3].map((i) => `<i${i <= t ? ' class="on"' : ''}></i>`).join('');
  return `<span class="threat t${t}">THREAT ${pips} ${THREAT_NAMES[t]}</span>`;
}

/** One job of a chapter, as the briefing lists it. */
function stepLine(c: Chapter, s: StepDef): string {
  switch (s.kind) {
    case 'power':
      return `<b>${s.text}</b>`;
    case 'parts':
      return `FIND THE <b>${s.names.join('</b>, THE <b>')}</b>`;
    case 'build':
      return `BUILD THE <b>${c.device}</b> AT THE WORKBENCH`;
    case 'valves':
      return `OPEN ALL THREE <b>${s.name}S</b> WITHIN <b>${s.window} SECONDS</b> &mdash; THEY ALL SHUT AGAIN IF YOU ARE TOO SLOW`;
    case 'harvest':
      return `<b>${s.text}</b> &mdash; KILL <b>${s.kills}</b> OF THEM INSIDE ITS RING`;
    case 'defend':
      return `DEFEND THE <b>${c.device}</b> FOR <b>${s.seconds} SECONDS</b> &mdash; STAY INSIDE ITS RING WHILE THEY SWARM IT`;
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
  const musicInput = el<HTMLInputElement>('opt-music');
  const invertInput = el<HTMLInputElement>('opt-invert');
  const fovInput = el<HTMLInputElement>('opt-fov');
  const brightInput = el<HTMLInputElement>('opt-bright');
  const barsInput = el<HTMLInputElement>('opt-bars');
  const numbersInput = el<HTMLInputElement>('opt-numbers');

  /**
   * The HOW TO PLAY key list, written from the bindings in play so a rebind
   * shows up there too. Only each action's first key is named: the alternates
   * (the arrow keys, the second shift) would crowd the column out.
   */
  const renderHowtoKeys = (): void => {
    const k = (a: Action): string => game.input.label(a);
    const rows: [string, string][] = [
      [`${k('forward')} ${k('left')} ${k('back')} ${k('right')}`, 'move'],
      ['MOUSE', 'look'],
      ['LMB', 'fire'],
      ['RMB', 'aim'],
      [k('sprint'), 'sprint'],
      [k('jump'), 'jump'],
      [k('reload'), 'reload'],
      [k('use'), 'buy / use / repair'],
      [k('melee'), 'knife'],
      [k('grenade'), 'grenade'],
      [`${k('slot1')} ${k('slot2')} / ${k('swap')}`, 'swap weapon'],
      [k('map'), 'map'],
      [`${k('mute')} mute   ESC`, 'pause'],
    ];
    el('howto-keys').replaceChildren(
      ...rows.map(([key, what]) => {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = key;
        li.append(b, document.createTextNode(` ${what}`));
        return li;
      }),
    );
    el('howto-use').textContent = k('use');
  };

  const applySettings = (): void => {
    game.setQuality(QUALITY_PRESETS[settings.quality] as RetroQuality);
    game.input.sensitivity = settings.sensitivity / 10000;
    game.input.invertY = settings.invertY;
    game.setFov(settings.fov);
    game.retro.setExposure(exposureFor(settings.brightness));
    audio.setVolume(settings.volume / 100);
    audio.setMusicVolume(settings.musicVolume / 100);
    game.tags.showBars = settings.healthBars;
    game.tags.showNumbers = settings.damageNumbers;
    game.input.setBindings(settings.keys);
    renderHowtoKeys();
    el('val-sens').textContent = (settings.sensitivity / 10).toFixed(1);
    el('val-vol').textContent = String(settings.volume);
    el('val-music').textContent = String(settings.musicVolume);
    el('val-fov').textContent = String(settings.fov);
    el('val-bright').textContent = String(settings.brightness);
    qualitySel.value = settings.quality;
    sensInput.value = String(settings.sensitivity);
    volInput.value = String(settings.volume);
    musicInput.value = String(settings.musicVolume);
    invertInput.checked = settings.invertY;
    fovInput.value = String(settings.fov);
    brightInput.value = String(settings.brightness);
    barsInput.checked = settings.healthBars;
    numbersInput.checked = settings.damageNumbers;
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
  musicInput.addEventListener('input', () => {
    settings.musicVolume = Number(musicInput.value);
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
  barsInput.addEventListener('change', () => {
    settings.healthBars = barsInput.checked;
    applySettings();
  });
  numbersInput.addEventListener('change', () => {
    settings.damageNumbers = numbersInput.checked;
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
        threatBadge(c) +
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
    el('brief-title').textContent = c.title;
    el('brief-text').innerHTML = c.briefing.map((para) => `<p>${para}</p>`).join('');
    el('brief-chapter').innerHTML = `CHAPTER ${c.number}  ·  ${MAPS[m].name}  ·  ${threatBadge(c)}`;
    el('brief-steps').innerHTML = [
      ...c.steps.map((s) => stepLine(c, s)),
      `SURVIVE <span class="boss">${c.bossName}</span> &mdash; ${c.bossNote}`,
      `ESCAPE THROUGH <b>${c.exit}</b>`,
    ].map((li) => `<li>${li}</li>`).join('');
    showPanel('brief');
    el('btn-begin').focus();
  };

  /** Records a finished run, returning the note to show if it opened a new map. */
  /** Records a finished run: the note to show if it opened a new map, and whether it was a best. */
  const record = (stats: RunStats): { note: string | null; best: boolean } => {
    const res = recordRun(progress, stats.map, {
      round: stats.round, kills: stats.kills, points: stats.points, escaped: stats.escaped,
    });
    saveProgress(progress);
    renderBest();
    return {
      note: res.unlocked ? `NEW CHAPTER UNLOCKED: ${MAPS[res.unlocked].name}` : null,
      best: res.best,
    };
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
    showSettingsPanel('opts');
    qualitySel.focus();
  };

  /* ----------------------------------------------------------- rebinding */

  // The settings overlay holds two panels: the sliders, and the key list.
  const settingsPanels = { opts: el('menu-settings'), controls: el('menu-controls') };
  const keyRows = el('key-rows');
  // The action waiting for a key, if the player is part-way through a rebind.
  let listening: Action | null = null;

  const showSettingsPanel = (name: keyof typeof settingsPanels): void => {
    if (name !== 'controls') listening = null;
    for (const [key, node] of Object.entries(settingsPanels)) {
      node.classList.toggle('hidden', key !== name);
    }
  };

  /** Each action and the keys it answers to, with the one being rebound lit up. */
  const renderKeys = (): void => {
    keyRows.replaceChildren(
      ...REBINDABLE.map(({ action, name }) => {
        const row = document.createElement('div');
        row.className = 'bind';
        const label = document.createElement('span');
        label.textContent = name;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = listening === action
          ? 'PRESS A KEY'
          : game.input.keysFor(action).map(keyLabel).join(' / ') || '--';
        button.classList.toggle('listening', listening === action);
        button.addEventListener('click', () => {
          listening = listening === action ? null : action;
          renderKeys();
        });
        row.append(label, button);
        return row;
      }),
    );
  };

  /**
   * Gives a key to the action waiting for one. The key is taken off whatever
   * else had it, so a binding never does two things at once, and an action left
   * with nothing falls back to its default rather than becoming unusable.
   */
  const bindKey = (code: string): void => {
    const action = listening;
    if (!action) return;
    listening = null;
    const next: Partial<Record<Action, string[]>> = {};
    for (const { action: a } of REBINDABLE) {
      const keep = [...game.input.keysFor(a)].filter((c) => c !== code);
      next[a] = a === action ? [code] : keep.length ? keep : [...DEFAULT_KEYS[a]].filter((c) => c !== code);
    }
    // Only the actions that now differ from the defaults are worth storing.
    settings.keys = {};
    for (const { action: a } of REBINDABLE) {
      const codes = next[a] ?? [];
      if (codes.join() !== DEFAULT_KEYS[a].join()) settings.keys[a] = codes;
    }
    applySettings();
    renderKeys();
  };

  const openControls = (): void => {
    showSettingsPanel('controls');
    renderKeys();
    el('btn-controls-back').focus();
  };

  el('btn-controls').addEventListener('click', () => openControls());
  el('btn-controls-back').addEventListener('click', () => {
    showSettingsPanel('opts');
    el('btn-controls').focus();
  });
  el('btn-keys-reset').addEventListener('click', () => {
    listening = null;
    settings.keys = {};
    applySettings();
    renderKeys();
  });

  const closeSettings = (): void => {
    const from = settingsFrom;
    settingsFrom = null;
    listening = null;
    showSettingsPanel('opts');
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
    // recordRun decides what counts as a best - the same round with more points
    // does - so the banner takes its word for it rather than guessing again.
    const { note, best: isBest } = record(stats);
    const best = progress.records[stats.map]?.bestRound ?? stats.round;
    el('go-stats').innerHTML = statsRows([
      ['CHAPTER', `${CHAPTERS[stats.map].number}: ${CHAPTERS[stats.map].title}`],
      ['SURVIVED TO ROUND', String(stats.round)],
      ['KILLS', String(stats.kills)],
      ['HEADSHOTS', String(stats.headshots)],
      ['POINTS EARNED', String(stats.points)],
      ['TIME', fmtTime(stats.seconds)],
      ['BEST ROUND HERE', String(best)],
    ]) + (isBest ? '<div style="color:#ffc84d;margin-top:10px">NEW PERSONAL BEST</div>' : '');
    showUnlock('go-unlock', note);
  };

  game.onVictory = (stats: RunStats) => {
    const { note } = record(stats);
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

  // A rebind in progress swallows the next key, before anything else sees it.
  window.addEventListener('keydown', (e) => {
    if (!listening) return;
    if (e.code === 'Escape') {
      listening = null;
      renderKeys();
    } else if (bindable(e.code)) {
      bindKey(e.code);
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });

  window.addEventListener('keydown', (e) => {
    // Both of these toggle, so a held key must not fire them over and over.
    if (e.repeat) return;
    if (e.code === 'Escape') {
      // Esc backs out one level: the key list, then settings, then the pause
      // menu, then into play.
      if (settingsFrom && !settingsPanels.controls.classList.contains('hidden')) {
        showSettingsPanel('opts');
        el('btn-controls').focus();
      } else if (settingsFrom) closeSettings();
      else if (game.state === 'playing') game.pause();
      else if (game.state === 'paused') {
        game.resumeGame();
        game.input.requestLock();
      }
    }
    // Mute follows its binding rather than a key of its own, so rebinding it works.
    if (game.state !== 'menu' && game.input.keysFor('mute').includes(e.code)) {
      audio.setMuted(!audio.muted);
    }
  });

  window.addEventListener('resize', () => game.resize());

  /*
   * A lost GL context - a driver reset, a laptop switching GPUs, the browser
   * reclaiming memory - takes every texture, buffer and baked light with it,
   * and all of those are generated at load rather than loaded from a file. So
   * there is nothing to re-upload: say what happened and offer a reload, rather
   * than leave the player looking at a frozen picture. Cancelling the event is
   * what stops the browser tearing the canvas down before the message shows.
   */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (game.state === 'playing') game.pause();
    bootScreen.innerHTML =
      '<div class="menu-inner"><div class="boot-text" style="animation:none">' +
      'GRAPHICS CONTEXT LOST.<br><br>' +
      '<small style="opacity:.6">THE BROWSER DROPPED THE 3D VIEW. RELOAD TO CARRY ON.</small>' +
      '</div></div>';
    bootScreen.classList.remove('hidden');
  });

  /* ---------------------------------------------------------------- loop */

  let last = performance.now();
  let accumulator = 0;
  const STEP = 1 / 120;

  // The loop owns presentation: the HUD is painted once per drawn frame, not
  // once per simulation step.
  game.hostPresents = true;

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

    game.present(elapsed);
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
