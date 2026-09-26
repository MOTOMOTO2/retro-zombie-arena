/**
 * Keyboard + mouse with pointer lock. Keys are tracked by `event.code` so the
 * layout works the same on AZERTY and QWERTY, and every action but the pause
 * key can be rebound (see DEFAULT_KEYS and setBindings).
 */

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'sprint' | 'jump' | 'reload' | 'use' | 'melee' | 'grenade'
  | 'slot1' | 'slot2' | 'swap' | 'pause' | 'map' | 'mute';

/** What each action answers to out of the box. The first key is the one the HUD names. */
export const DEFAULT_KEYS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  reload: ['KeyR'],
  use: ['KeyF', 'KeyE'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  swap: ['KeyQ'],
  map: ['Tab'],
  mute: ['KeyM'],
  pause: ['Escape'],
};

/**
 * The actions the settings screen offers, in the order it lists them, with the
 * name it gives each one. `pause` is not among them: Esc is the way out of
 * every screen in the game, so it stays where it is.
 */
export const REBINDABLE: { action: Action; name: string }[] = [
  { action: 'forward', name: 'MOVE FORWARD' },
  { action: 'back', name: 'MOVE BACK' },
  { action: 'left', name: 'STRAFE LEFT' },
  { action: 'right', name: 'STRAFE RIGHT' },
  { action: 'sprint', name: 'SPRINT' },
  { action: 'jump', name: 'JUMP' },
  { action: 'reload', name: 'RELOAD' },
  { action: 'use', name: 'BUY / USE / REPAIR' },
  { action: 'melee', name: 'KNIFE' },
  { action: 'grenade', name: 'GRENADE' },
  { action: 'slot1', name: 'WEAPON 1' },
  { action: 'slot2', name: 'WEAPON 2' },
  { action: 'swap', name: 'SWAP WEAPON' },
  { action: 'map', name: 'MAP' },
  { action: 'mute', name: 'MUTE' },
];

/** Keys the game will not hand over: the browser or the game needs them. */
const RESERVED = new Set(['Escape', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight']);

/** Whether a key is one the player is allowed to bind. */
export function bindable(code: string): boolean {
  return Boolean(code) && !RESERVED.has(code);
}

/** A key as the settings screen and the HUD write it. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6).toUpperCase()}`;
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  const named: Record<string, string> = {
    Space: 'SPACE', Tab: 'TAB', Escape: 'ESC', Enter: 'ENTER', Backspace: 'BKSP',
    CapsLock: 'CAPS', ContextMenu: 'MENU', Insert: 'INS', Delete: 'DEL',
    Home: 'HOME', End: 'END', PageUp: 'PG UP', PageDown: 'PG DN',
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
    AltLeft: 'L ALT', AltRight: 'R ALT',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
    Comma: ',', Period: '.', Slash: '/',
  };
  return named[code] ?? code.toUpperCase();
}

/** Key codes the game would rather the browser did not act on itself. */
const SWALLOW = new Set(['Tab', 'Space', 'Backspace', 'Quote', 'Slash']);

export class Input {
  private readonly down = new Set<Action>();
  private readonly pressed = new Set<Action>();
  /** Which action each key code fires. Rebuilt whenever the bindings change. */
  private bindings: Record<string, Action> = {};
  /** The keys each action answers to, in the order the settings screen shows them. */
  private keys: Record<Action, string[]> = { ...DEFAULT_KEYS };
  mouseDX = 0;
  mouseDY = 0;
  fire = false;
  firePressed = false;
  aim = false;
  wheel = 0;
  sensitivity = 0.0022;
  invertY = false;
  locked = false;

  private readonly canvas: HTMLElement;
  private readonly onLockChange: (locked: boolean) => void;

  constructor(canvas: HTMLElement, onLockChange: (locked: boolean) => void) {
    this.canvas = canvas;
    this.onLockChange = onLockChange;
    this.setBindings(DEFAULT_KEYS);

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('wheel', this.handleWheel, { passive: true });
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('contextmenu', this.handleContextMenu);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const action = this.bindings[e.code];
    if (!action) return;
    // Keys the browser would otherwise act on: Tab moves focus, Space scrolls.
    if (SWALLOW.has(e.code)) e.preventDefault();
    if (!this.down.has(action)) this.pressed.add(action);
    this.down.add(action);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const action = this.bindings[e.code];
    if (action) this.down.delete(action);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (e.button === 0) {
      if (!this.fire) this.firePressed = true;
      this.fire = true;
    }
    if (e.button === 2) this.aim = true;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.fire = false;
    if (e.button === 2) this.aim = false;
  };

  private handleWheel = (e: WheelEvent): void => {
    if (this.locked) this.wheel += Math.sign(e.deltaY);
  };

  private handleContextMenu = (e: Event): void => {
    if (this.locked) e.preventDefault();
  };

  private handleLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.releaseAll();
    this.onLockChange(this.locked);
  };

  private releaseAll = (): void => {
    this.down.clear();
    this.fire = false;
    this.aim = false;
  };

  /**
   * Replaces the key map. Anything left out keeps its default, and a key given
   * to two actions goes to the last one asking, so a rebind never leaves the
   * player with a key that does two things at once.
   */
  setBindings(keys: Partial<Record<Action, string[]>>): void {
    const next = { ...DEFAULT_KEYS };
    for (const [action, codes] of Object.entries(keys) as [Action, string[] | undefined][]) {
      if (codes?.length) next[action] = codes.filter(bindable);
    }
    this.keys = next;
    const lookup: Record<string, Action> = {};
    for (const [action, codes] of Object.entries(next) as [Action, string[]][]) {
      for (const code of codes) lookup[code] = action;
    }
    this.bindings = lookup;
    this.releaseAll();
  }

  /** The keys an action answers to. */
  keysFor(action: Action): readonly string[] {
    return this.keys[action];
  }

  /** How the HUD names an action: its first key, or nothing if it has none. */
  label(action: Action): string {
    const code = this.keys[action][0];
    return code ? keyLabel(code) : '--';
  }

  requestLock(): void {
    const el = this.canvas as HTMLElement & { requestPointerLock(opts?: object): void };
    try {
      el.requestPointerLock();
    } catch {
      /* Safari throws if called outside a gesture; the menu button retries. */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(a: Action): boolean {
    return this.down.has(a);
  }

  /** True once per physical press. */
  consume(a: Action): boolean {
    if (!this.pressed.has(a)) return false;
    this.pressed.delete(a);
    return true;
  }

  takeMouse(): { dx: number; dy: number } {
    const dx = this.mouseDX * this.sensitivity;
    const dy = this.mouseDY * this.sensitivity * (this.invertY ? -1 : 1);
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  takeFirePress(): boolean {
    const f = this.firePressed;
    this.firePressed = false;
    return f;
  }

  /** Clears one-shot state at the end of a frame. */
  endFrame(): void {
    this.pressed.clear();
    this.firePressed = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    document.removeEventListener('contextmenu', this.handleContextMenu);
  }
}
