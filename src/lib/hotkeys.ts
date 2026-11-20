import { useEffect, useRef } from 'react';

/**
 * The app's keyboard shortcuts in one place (#68): the key map, the matching rules and the
 * hook that listens. Screens only say what an action does (`useHotkeys({ selectAll: ... })`).
 *
 * Rules, the same for every shortcut:
 * - nothing fires while a dialog, context menu or dropdown is open: its keys belong to it
 * - nothing fires while the focus is in a text field, so Ctrl+A there selects the text
 *   (only bindings marked `inFields` do, which is Ctrl+K as before)
 * - the modifier is Cmd on macOS and Ctrl elsewhere; a shortcut with any other modifier
 *   held down is a different shortcut and not ours
 * - the browser default is suppressed only when the shortcut did something
 */
export type HotkeyAction = 'selectAll' | 'focusSearch' | 'delete' | 'rename' | 'open' | 'clearSelection';

export interface Hotkey {
  action: HotkeyAction;
  /** `KeyboardEvent.key`, lower case. */
  key: string;
  /** Needs Cmd (macOS) or Ctrl (elsewhere). */
  mod?: boolean;
  /** Also fires while the focus is in a text field. */
  inFields?: boolean;
  /** Only on macOS (`true`) or only elsewhere (`false`). */
  mac?: boolean;
}

export const HOTKEYS: readonly Hotkey[] = [
  { action: 'selectAll', key: 'a', mod: true },
  { action: 'focusSearch', key: 'f', mod: true },
  { action: 'focusSearch', key: 'k', mod: true, inFields: true },
  { action: 'open', key: 'enter' },
  { action: 'rename', key: 'f2' },
  { action: 'delete', key: 'delete' },
  // Mac laptops have no Delete key; Finder moves to the trash with Cmd+Backspace
  { action: 'delete', key: 'backspace', mod: true, mac: true },
  { action: 'clearSelection', key: 'escape' },
];

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/** The binding a key press stands for, or `null` when it is none of ours. */
export function matchHotkey(e: KeyLike, mac = isMac()): Hotkey | null {
  if (e.altKey || e.shiftKey) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (other) return null;
  const key = e.key.toLowerCase();
  return HOTKEYS.find((h) => h.key === key && !!h.mod === mod && (h.mac === undefined || h.mac === mac)) ?? null;
}

const FIELDS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Radix renders these only while they are open (and while they animate out). */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

type Closest = { closest?: (sel: string) => unknown } | null;

export function isFieldTarget(target: EventTarget | null): boolean {
  const el = target as Closest;
  return typeof el?.closest === 'function' && el.closest(FIELDS) != null;
}

export function overlayOpen(doc: Pick<Document, 'querySelector'>): boolean {
  return doc.querySelector(OVERLAYS) != null;
}

/** Whether a matched binding may fire for this target right now. */
export function hotkeyAllowed(h: Hotkey, target: EventTarget | null, doc: Pick<Document, 'querySelector'>): boolean {
  if (overlayOpen(doc)) return false;
  return !!h.inFields || !isFieldTarget(target);
}

/** Key caps of a binding for display, e.g. `['mod', 'a']`; `mod` reads Ctrl or ⌘. */
export function hotkeyCaps(h: Hotkey, mac = isMac()): string[] {
  return h.mod ? [mac ? 'cmd' : 'ctrl', h.key] : [h.key];
}

/** The bindings to show for an action on this platform. */
export function hotkeysFor(action: HotkeyAction, mac = isMac()): Hotkey[] {
  return HOTKEYS.filter((h) => h.action === action && (h.mac === undefined || h.mac === mac));
}

/** A handler returns `false` when it had nothing to do; the key then keeps its default. */
export type HotkeyHandlers = Partial<Record<HotkeyAction, (e: KeyboardEvent) => boolean | void>>;

/**
 * Listens on the window in the capture phase: a dialog or menu that closes on the same key
 * is then still open when the rules are checked, so its Escape never reaches the screen.
 */
export function useHotkeys(handlers: HotkeyHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = matchHotkey(e);
      if (!h) return;
      const run = latest.current[h.action];
      if (!run || !hotkeyAllowed(h, e.target, document)) return;
      if (run(e) !== false) e.preventDefault();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
}
