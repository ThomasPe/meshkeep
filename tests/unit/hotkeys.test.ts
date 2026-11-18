import { describe, expect, it } from 'vitest';
import { HOTKEYS, hotkeyAllowed, hotkeyCaps, hotkeysFor, isFieldTarget, matchHotkey, overlayOpen } from '@/lib/hotkeys';

const k = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const el = (field: boolean) => ({ closest: (sel: string) => (field && sel.includes('input') ? {} : null) }) as unknown as EventTarget;
const doc = (open: boolean) => ({ querySelector: () => (open ? {} : null) }) as unknown as Document;
const action = (e: ReturnType<typeof k>, mac: boolean) => matchHotkey(e, mac)?.action ?? null;

describe('hotkeys', () => {
  it('matches Ctrl on Windows and Linux, Cmd on macOS', () => {
    expect(action(k('a', { ctrlKey: true }), false)).toBe('selectAll');
    expect(action(k('A', { ctrlKey: true }), false)).toBe('selectAll'); // caps lock
    expect(action(k('a', { metaKey: true }), false)).toBeNull();
    expect(action(k('a', { metaKey: true }), true)).toBe('selectAll');
    expect(action(k('a', { ctrlKey: true }), true)).toBeNull();
    expect(action(k('a'), false)).toBeNull();
    expect(action(k('f', { ctrlKey: true }), false)).toBe('focusSearch');
    expect(action(k('k', { ctrlKey: true }), false)).toBe('focusSearch');
    expect(action(k('k', { metaKey: true }), true)).toBe('focusSearch');
  });
  it('matches the plain keys only without a modifier', () => {
    expect(action(k('Delete'), false)).toBe('delete');
    expect(action(k('F2'), false)).toBe('rename');
    expect(action(k('Enter'), false)).toBe('open');
    expect(action(k('Escape'), true)).toBe('clearSelection');
    expect(action(k('Delete', { ctrlKey: true }), false)).toBeNull();
    expect(action(k('Delete', { shiftKey: true }), false)).toBeNull(); // Explorer: delete for good, which the app never does
    expect(action(k('Enter', { altKey: true }), false)).toBeNull();
    expect(action(k('a', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(action(k('a', { ctrlKey: true, altKey: true }), false)).toBeNull(); // AltGr on Windows
    expect(action(k('x'), false)).toBeNull();
  });
  it('knows Cmd+Backspace on macOS only', () => {
    expect(action(k('Backspace', { metaKey: true }), true)).toBe('delete');
    expect(action(k('Backspace', { ctrlKey: true }), false)).toBeNull();
    expect(action(k('Backspace'), true)).toBeNull();
    expect(hotkeysFor('delete', true).map((h) => h.key)).toEqual(['delete', 'backspace']);
    expect(hotkeysFor('delete', false).map((h) => h.key)).toEqual(['delete']);
  });
  it('stays out of text fields and open dialogs or menus', () => {
    const selectAll = HOTKEYS.find((h) => h.action === 'selectAll')!;
    const ctrlK = HOTKEYS.find((h) => h.key === 'k')!;
    expect(isFieldTarget(el(true))).toBe(true);
    expect(isFieldTarget(el(false))).toBe(false);
    expect(isFieldTarget(null)).toBe(false);
    expect(overlayOpen(doc(true))).toBe(true);
    expect(hotkeyAllowed(selectAll, el(false), doc(false))).toBe(true);
    expect(hotkeyAllowed(selectAll, el(true), doc(false))).toBe(false);
    expect(hotkeyAllowed(selectAll, el(false), doc(true))).toBe(false);
    expect(hotkeyAllowed(ctrlK, el(true), doc(false))).toBe(true); // jumps to the search from another field
    expect(hotkeyAllowed(ctrlK, el(true), doc(true))).toBe(false);
  });
  it('names the key caps per platform', () => {
    const selectAll = HOTKEYS.find((h) => h.action === 'selectAll')!;
    expect(hotkeyCaps(selectAll, false)).toEqual(['ctrl', 'a']);
    expect(hotkeyCaps(selectAll, true)).toEqual(['cmd', 'a']);
    expect(hotkeyCaps(HOTKEYS.find((h) => h.action === 'rename')!, false)).toEqual(['f2']);
  });
});
