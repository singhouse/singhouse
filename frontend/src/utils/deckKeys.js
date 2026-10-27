// SPDX-License-Identifier: AGPL-3.0-only
//
// Who owns a key press: the deck's playback shortcuts or whatever has focus.
// Shared by the player and by the shell, which takes Space itself while no
// player is mounted yet (the first song of a session still on its way).
//
// Space belongs to the deck everywhere except where it types and while a
// modal dialog is up. Non-modal popovers (PopoverMenu's default
// role="dialog") own nothing. A modal dialog — Modal.vue's native
// showModal() dialog, any [aria-modal="true"] surface, an alertdialog — owns
// every deck key, which is what leaves the play guard's own prompt in charge
// of its Space and Enter.

export const TEXT_ENTRY = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"])'
    + ':not([type="checkbox"]):not([type="radio"]):not([type="range"])'
    + ':not([type="color"]):not([type="file"]):not([type="image"])',
  'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
].join(', ')
export const MODAL = '[aria-modal="true"], [role="alertdialog"]'
// A Modal dialog closing (still in the DOM for its leave transition, no
// longer open) owns nothing.
export const OPEN_MODAL = 'dialog[open][aria-modal="true"], [role="alertdialog"]:not(dialog)'

export function focusedElements(e) {
  return [e.target, document.activeElement].filter(el => el && typeof el.closest === 'function')
}

export function focusInside(e, selector) {
  return focusedElements(e).some(el => el.closest(selector))
}

export function modalOpen(e) {
  return focusInside(e, MODAL) || !!document.querySelector(OPEN_MODAL)
}

export function spaceBelongsElsewhere(e) {
  return modalOpen(e) || focusInside(e, TEXT_ENTRY)
}
