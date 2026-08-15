# Instacart Substitution Spotlight

A Chrome extension (Manifest V3) that surfaces which grocery items are silently
set to auto-substitute — and lets you change that setting in one click, without
hunting through Instacart's own menus.

> Unofficial personal project. Not affiliated with, endorsed by, or built with
> Instacart. Runs locally via `chrome://extensions` → Load unpacked.

---

## The problem

Instacart defaults many cart items to **"Replace with best match"**: if your item
is out of stock, the shopper substitutes something similar. That is reasonable
for paper towels and a real problem if you have allergies, dietary
restrictions, or a brand you actually need.

The setting is easy to miss. It lives as small text on each cart row, and
changing it takes several clicks per item.

## What this does

- **Flags** cart items on auto "best match".
- **Counts** how many are still on that setting.
- **Changes the real setting** from the badge (Instacart's own dialog + Save).
- **Local notes** for a personal reminder. Not sent to the shopper.

No network calls. No analytics. One permission (`storage`) for local notes.

---

## Engineering notes

The UI is small. The work is driving a production React cart you don't control.

**Class names are unusable.** Instacart's styles are CSS-in-JS with hashed
names (`e-1wuip3z`) that change every deploy. Nothing is selected by class.
Instead the extension anchors to the accessibility tree and to visible copy:

```js
// Every cart item is a labeled group — the stable per-item anchor.
const items = document.querySelectorAll('[role="group"][aria-label]');
```

**Drive the real control, don't simulate it.** Changing substitution means
opening Instacart's "If out of stock…" modal, selecting the native radio, and
clicking their Save — so the change actually reaches their backend.

**Survive re-renders.** The cart is a SPA, so a debounced `MutationObserver`
re-scans on DOM change. Badge injection is idempotent, and mutations caused by
the extension's own UI are filtered out to avoid feedback loops.

**Custom widgets need real input events.** A bare `.click()` was ignored by
Instacart's radios, so interaction replays a full pointer sequence
(`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`) and verifies
the option looks selected before continuing.

### Bugs we hit

| Symptom | Root cause |
| --- | --- |
| Extension matched itself | The badge's own text contained "best match," so the scanner treated extension UI as Instacart's control |
| Wrong container targeted | The cart drawer is also `role="dialog"` and contains dozens of "Replace with best match" buttons |
| Editing item A opened item B | A synthetic click on Save/Close fell through onto the cart row underneath |
| "It won't save" | On tall modals, Save renders below the fold; cleanup ran before the change persisted and cancelled it |

Fixes, in order: exclude extension UI from all queries; identify the real modal
by requiring "Refund this item"; dismiss with `Escape` instead of clicking;
scroll Save into view and wait for the cart row to confirm before closing.

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (the one with `manifest.json`)
4. Open an Instacart cart (`instacart.com` / `instacart.ca`) and refresh

Upgrading from an earlier build: click **Reload** on the extension card, then
refresh the cart tab.

## Using it

Click the yellow badge on any flagged item:

- **Best match (current)** — no change, closes the popover
- **Don't replace — refund me instead** — selects Instacart's native
  "Refund this item" radio and saves it
- **Let me pick a specific backup** — selects "Replace with specific item" and
  surfaces their replacement carousel; the text field saves a local reminder

A successful refund flips the cart row to "Refund this item" and clears the
badge on the next scan.

## Verifying it works

Open DevTools → Console and look for `[SubSpotlight]` output:

```
[SubSpotlight] Clicking Instacart substitution button for: Natrel 3.8% Organic Filtered Milk (2 L)
[SubSpotlight] Selecting option: refund this item
[SubSpotlight] Clicking Save for: Natrel 3.8% Organic Filtered Milk (2 L)
[SubSpotlight] Cart row confirmed leave-best-match after Save
```

Console logs use `[SubSpotlight]`. Selectors depend on Instacart's copy, so
that's the fastest way to tell a UI change from a real bug.

---

## Known limitations

- **Specific-backup notes are local only.** There is no public API to send a
  shopper "get this instead," so notes live in `chrome.storage.local` on one
  browser profile. The UI labels this clearly rather than implying the shopper
  will see it.
- **Copy-dependent selectors.** Matching relies on visible text like
  "Refund this item." If Instacart rewords its dialog, update
  `DONT_REPLACE_PATTERNS` / `SUB_BUTTON_PATTERNS` at the top of `content.js`.
- **Verified on instacart.ca** against a Walmart Canada storefront. Other
  regions or A/B variants may use different wording.

## Roadmap

- Confirmation prompt before checkout if any item is still on auto-substitute
- Per-item defaults (e.g. always refund produce)
- Bulk action: set every flagged item to refund at once

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — content script + `storage` |
| `content.js` | Scanning, badges, popover, Instacart dialog automation, notes |
| `styles.css` | Badge, counter panel, popover, note styling |

Vanilla JS, no build step or bundler.
