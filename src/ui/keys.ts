import { useEffect, useState } from "react";

// The keyboard rules every screen shares (build prompt v2, section 4).

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The modifier key's name as people know it: Ctrl, or ⌘ on a Mac. */
export const MOD_KEY = MAC ? "⌘" : "Ctrl";

const FIELDS =
  'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]';

/**
 * Moves the cursor to the next field after this one, in the same part of the screen (a dialog, a section of a call
 * sheet, a page). After the last one, the field is simply left.
 */
export function focusNext(el: HTMLElement): void {
  const scope = el.closest(".modal, .cs-section, .pd-page, section, form") ?? document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FIELDS)].filter((x) => x === el || x.getClientRects().length > 0);
  const next = all[all.indexOf(el) + 1];
  if (next) next.focus();
  else el.blur();
}

/**
 * For Enter in a row's last field, which adds a row below: call the returned function with the new row's id, and once
 * the row is drawn (its element carries data-row="<id>") the cursor goes to its field matching `field`.
 */
export function useFocusRow(field: string): (rowId: string) => void {
  const [row, setRow] = useState<string | null>(null);
  useEffect(() => {
    if (!row) return;
    const input = document.querySelector<HTMLInputElement>(`[data-row="${row}"] ${field}`);
    if (!input) return; // not drawn yet: tried again on the next render
    input.focus();
    input.select();
    setRow(null);
  });
  return setRow;
}
