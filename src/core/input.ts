/**
 * Keyboard + mouse with pointer lock. Keys are tracked by `event.code` so the
 * layout works the same on AZERTY and QWERTY.
 */

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'sprint' | 'jump' | 'reload' | 'use' | 'melee' | 'grenade'
  | 'slot1' | 'slot2' | 'slot3' | 'swap' | 'pause' | 'map' | 'mute';

const BINDINGS: Record<string, Action> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'jump',
  KeyR: 'reload',
  KeyF: 'use', KeyE: 'use',
  KeyV: 'melee',
  KeyG: 'grenade',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3',
  KeyQ: 'swap',
  Escape: 'pause',
  Tab: 'map',
  KeyM: 'mute',
};

export class Input {
  private readonly down = new Set<Action>();
  private readonly pressed = new Set<Action>();
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
    const action = BINDINGS[e.code];
    if (!action) return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!this.down.has(action)) this.pressed.add(action);
    this.down.add(action);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const action = BINDINGS[e.code];
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
