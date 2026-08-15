/**
 * Instacart Substitution Spotlight — content script
 *
 * Existing behavior: flag cart items whose substitution setting is
 * "Replace with best match", show a badge + floating counter.
 *
 * New (v1.1): clicking OUR badge opens a small popover so the customer
 * can try to change the real Instacart setting, or leave a local-only
 * personal note when Instacart has no equivalent control to hook into.
 *
 * VERIFY IN DEVTOOLS (assumptions marked with "ASSUMPTION:"):
 * - Cart items are [role="group"][aria-label="<product name>"].
 * - The substitution control is a <button> whose text includes
 *   "best match" (or similar — see SUB_BUTTON_PATTERNS).
 * - VERIFIED (instacart.ca, 2026-07): clicking that button opens a
 *   dialog/modal titled like "If out of stock..." with radio options:
 *     • "Replace with specific item"  (+ product carousel)
 *     • "Replace with best match"
 *     • "Refund this item"
 *   We do not hardcode Instacart's CSS-in-JS class hashes.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const PROCESSED_ATTR = 'data-sub-spotlight';
  const BADGE_CLASS = 'sub-spotlight-badge';
  const NOTE_BADGE_CLASS = 'sub-spotlight-note-badge';
  const PANEL_ID = 'sub-spotlight-panel';
  const POPOVER_ID = 'sub-spotlight-popover';
  const LOG_PREFIX = '[SubSpotlight]';

  /** chrome.storage.local key for personal backup notes (not sent to Instacart). */
  const NOTES_STORAGE_KEY = 'subSpotlightNotes';

  /**
   * ASSUMPTION: Instacart's substitution trigger button text includes one
   * of these substrings (case-insensitive). Expand if you see different
   * wording in your locale / A/B test.
   */
  const SUB_BUTTON_PATTERNS = ['best match', 'replace with best'];

  /**
   * Text patterns for the native refund / no-sub option inside Instacart's
   * "If out of stock..." dialog. Ordered most-specific first.
   * VERIFIED label on instacart.ca: "Refund this item"
   */
  const DONT_REPLACE_PATTERNS = [
    'refund this item',
    'refund me',
    'refund instead',
    "don't replace",
    'dont replace',
    'do not replace',
    'no substitution',
    'no replacements',
    // Broad fallback — keep last so tighter labels win when scoring.
    'refund',
  ];

  /**
   * Patterns for Instacart's "pick a specific replacement" radio.
   * VERIFIED label on instacart.ca: "Replace with specific item"
   * Prefer the full phrase so we don't accidentally match carousel
   * product tiles that merely contain the word "specific".
   */
  const SPECIFIC_REPLACEMENT_PATTERNS = [
    'replace with specific item',
    'specific item',
    'choose a replacement',
    'choose replacement',
    'pick a replacement',
    'select a replacement',
    'find a replacement',
  ];

  // In-memory cache of notes; hydrated from chrome.storage.local on load.
  let notesByProduct = {};

  /** Serialize Instacart modal automation — overlapping runs caused milk→pepper click-through. */
  let interactionChain = Promise.resolve();

  // ---------------------------------------------------------------------------
  // Logging helpers — leave these on so you can verify probe results live
  // ---------------------------------------------------------------------------

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (stable selectors only — no CSS-in-JS class hashes)
  // ---------------------------------------------------------------------------

  /**
   * Finds Instacart's substitution-setting button inside one cart item.
   * Prefer text content over class names.
   *
   * IMPORTANT: Our own badge is also a <button> whose label includes
   * "best match". Always skip extension UI or a successful refund leaves
   * the badge in place and the next run "clicks" our badge instead of
   * Instacart's control (this is what looked like "stuck on the milk").
   */
  function findSubButton(item) {
    // Prefer submit buttons (verified in your DevTools notes), then any button.
    const candidates = [
      ...item.querySelectorAll('button[type="submit"]'),
      ...item.querySelectorAll('button'),
    ];
    const seen = new Set();
    for (const b of candidates) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (isOurUi(b)) continue;
      const text = (b.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (SUB_BUTTON_PATTERNS.some((p) => text.includes(p))) {
        return b;
      }
    }
    return null;
  }

  /**
   * True when Instacart's cart-row control already says refund (setting applied).
   * Used to know we can dismiss the modal even if Save isn't visible.
   */
  function itemAlreadyRefund(item) {
    if (!item) return false;
    const candidates = item.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      if (isOurUi(el)) continue;
      const text = normalizeText(el.textContent || el.getAttribute('aria-label') || '');
      if (text.includes('refund this item') || text === 'refund') return true;
    }
    return false;
  }

  /** Stable product key for storage — aria-label on the role="group" item. */
  function productKey(item) {
    return (item.getAttribute('aria-label') || '').trim();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function describeNode(el) {
    if (!el || !el.tagName) return String(el);
    const role = el.getAttribute('role') || '';
    const label =
      el.getAttribute('aria-label') ||
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return `<${el.tagName.toLowerCase()} role="${role}" text="${label}">`;
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isOurUi(el) {
    return !!(
      el &&
      el.closest &&
      el.closest('#' + POPOVER_ID + ', #' + PANEL_ID + ', .' + BADGE_CLASS + ', .' + NOTE_BADGE_CLASS)
    );
  }

  /**
   * Find option labels via TEXT NODES first (more reliable than element
   * textContent when the label and description share a parent).
   */
  function findLabelElement(roots, patterns) {
    let best = null;
    let bestScore = Infinity;

    for (const root of roots) {
      if (!root) continue;

      // Pass 1: text nodes — best for exact "Refund this item" labels.
      const doc = root.ownerDocument || document;
      try {
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
          const parent = textNode.parentElement;
          if (!parent || isOurUi(parent)) continue;
          const text = normalizeText(textNode.nodeValue);
          if (!text || text.length > 80) continue;
          const matchedPattern = patterns.find(
            (p) => text === p || text.includes(p)
          );
          if (!matchedPattern) continue;
          const exactBoost = text === matchedPattern ? -1000 : 0;
          const score = exactBoost + text.length - matchedPattern.length * 3;
          if (score < bestScore) {
            bestScore = score;
            best = { el: parent, text, matchedPattern };
          }
        }
      } catch (_) {
        /* ignore walker errors on detached nodes */
      }

      // Pass 2: elements (covers aria-label-only controls).
      if (!root.querySelectorAll) continue;
      try {
        const walkerEl = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walkerEl.nextNode())) {
          if (isOurUi(node)) continue;
          const aria = normalizeText(node.getAttribute('aria-label') || '');
          const text = aria || normalizeText(node.textContent);
          if (!text || text.length > 120) continue;
          const matchedPattern = patterns.find((p) => text.includes(p));
          if (!matchedPattern) continue;
          const exactBoost = text === matchedPattern ? -1000 : 0;
          const depth = node.getElementsByTagName
            ? node.getElementsByTagName('*').length
            : 0;
          const score =
            exactBoost + text.length + depth - matchedPattern.length * 3;
          if (score < bestScore) {
            bestScore = score;
            best = { el: node, text, matchedPattern };
          }
        }
      } catch (_) {
        /* ignore */
      }
    }

    return best;
  }

  /**
   * From a text label node, find the row Instacart actually expects clicks on.
   * Keep the target SMALL — walking up into the whole milk carousel container
   * makes the refund click miss / hit the wrong control.
   */
  function findClickableOptionRow(labelEl) {
    if (!labelEl) return null;

    let best = labelEl;
    let cur = labelEl;

    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      if (isOurUi(cur)) {
        cur = cur.parentElement;
        continue;
      }

      const t = normalizeText(cur.textContent);
      // Refund row = title + short description. Anything huge is the modal/carousel.
      if (t.length > 160) break;

      if (
        cur.matches &&
        cur.matches(
          'button, a, label, input[type="radio"], [role="radio"], [role="button"], [role="menuitemradio"]'
        )
      ) {
        return cur;
      }

      if (
        cur.querySelector &&
        cur.querySelector(
          'input[type="radio"], [role="radio"], [aria-checked], svg circle'
        )
      ) {
        best = cur;
      } else {
        try {
          if (window.getComputedStyle(cur).cursor === 'pointer') best = cur;
        } catch (_) {
          /* ignore */
        }
      }

      cur = cur.parentElement;
    }

    return best;
  }

  /**
   * Full pointer/mouse sequence — React + custom widgets often ignore a bare
   * .click() or a single MouseEvent('click').
   */
  function simulateUserClick(el) {
    if (!el) return false;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: 0,
      clientY: 0,
    };

    try {
      const r = el.getBoundingClientRect();
      opts.clientX = Math.round(r.left + Math.min(r.width / 2, 24));
      opts.clientY = Math.round(r.top + Math.min(r.height / 2, 12));
    } catch (_) {
      /* ignore */
    }

    const events = [
      ['pointerover', PointerEvent],
      ['pointerenter', PointerEvent],
      ['mouseover', MouseEvent],
      ['mouseenter', MouseEvent],
      ['pointerdown', PointerEvent],
      ['mousedown', MouseEvent],
      ['pointerup', PointerEvent],
      ['mouseup', MouseEvent],
      ['click', MouseEvent],
    ];

    for (const [type, Ctor] of events) {
      try {
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_) {
        try {
          el.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), opts));
        } catch (__) {
          /* ignore */
        }
      }
    }

    try {
      if (typeof el.click === 'function') el.click();
    } catch (_) {
      /* ignore */
    }

    if (el.tagName === 'INPUT' && el.type === 'radio') {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (el.getAttribute && el.getAttribute('role') === 'radio') {
      el.setAttribute('aria-checked', 'true');
    }

    return true;
  }

  /**
   * VERIFIED: the "IF OUT OF STOCK..." dialog has a green primary "Save"
   * button. Selecting a radio alone does NOT persist — Save must be clicked.
   * Prefer an enabled Save (Instacart may disable it until a radio changes).
   */
  function findSaveButton(roots) {
    let exactEnabled = null;
    let exactDisabled = null;
    let fuzzy = null;

    for (const root of roots) {
      if (!root || !root.querySelectorAll) continue;
      const buttons = root.querySelectorAll(
        'button, [role="button"], input[type="submit"]'
      );
      for (const b of buttons) {
        if (isOurUi(b)) continue;
        const text = normalizeText(b.textContent || b.value || '');
        if (!text) continue;
        if (text === 'save') {
          if (b.disabled || b.getAttribute('aria-disabled') === 'true') {
            exactDisabled = exactDisabled || b;
          } else {
            exactEnabled = b;
            break;
          }
        }
        if (!fuzzy && /^save\b/.test(text) && text.length < 40) {
          fuzzy = b;
        }
      }
      if (exactEnabled) break;
    }

    return exactEnabled || exactDisabled || fuzzy;
  }

  /** Scroll every overflow ancestor so Save is visible (milk modal is tall). */
  function scrollSaveIntoView(saveBtn) {
    if (!saveBtn) return;
    let cur = saveBtn.parentElement;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
      try {
        if (cur.scrollHeight > cur.clientHeight + 40) {
          const btnRect = saveBtn.getBoundingClientRect();
          const curRect = cur.getBoundingClientRect();
          const delta =
            btnRect.top - curRect.top - cur.clientHeight / 2 + btnRect.height / 2;
          cur.scrollTop += delta;
        }
      } catch (_) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    try {
      saveBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {
      /* ignore */
    }
  }

  async function waitForEnabledSave(roots, matchEl, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 2000);
    while (Date.now() < deadline) {
      let saveBtn = findSaveButton(roots);
      if (!saveBtn && matchEl) {
        let cur = matchEl;
        for (let i = 0; i < 12 && cur; i++) {
          saveBtn = findSaveButton([cur]);
          if (saveBtn) break;
          cur = cur.parentElement;
        }
      }
      if (
        saveBtn &&
        !saveBtn.disabled &&
        saveBtn.getAttribute('aria-disabled') !== 'true'
      ) {
        return saveBtn;
      }
      await wait(100);
    }
    // Return whatever we can find (even disabled) for logging.
    let saveBtn = findSaveButton(roots);
    if (!saveBtn && matchEl) {
      let cur = matchEl;
      for (let i = 0; i < 12 && cur; i++) {
        saveBtn = findSaveButton([cur]);
        if (saveBtn) break;
        cur = cur.parentElement;
      }
    }
    return saveBtn;
  }

  async function clickSaveRobustly(saveBtn) {
    if (!saveBtn) return false;
    scrollSaveIntoView(saveBtn);
    await wait(200);
    const r = saveBtn.getBoundingClientRect();
    const inView =
      r.top >= 0 && r.bottom <= (window.innerHeight || 800) + 40 && r.height > 0;
    log('Save button viewport check:', { inView, top: Math.round(r.top), bottom: Math.round(r.bottom) });
    simulateUserClick(saveBtn);
    await wait(180);
    // Second click helps when the first only focused a scroll container.
    simulateUserClick(saveBtn);
    return true;
  }

  /** Cart row no longer on best-match (refund or other setting applied). */
  function itemNoLongerBestMatch(item) {
    return !findSubButton(item) || itemAlreadyRefund(item);
  }

  /** True if this node looks like the cart drawer, not the sub preferences modal. */
  function isCartDrawerDialog(el) {
    if (!el) return false;
    const aria = normalizeText(el.getAttribute('aria-label') || '');
    // VERIFIED false positive from console: <div role="dialog" aria-label="Cart">
    if (aria === 'cart') return true;
    if (aria.includes('personal') && aria.includes('cart')) return true;
    return false;
  }

  /**
   * Distinctive tokens from a product aria-label, used to make sure the
   * open "IF OUT OF STOCK..." modal belongs to THIS cart row — not a stale
   * leftover from milk (or any previous item).
   */
  function productMatchTokens(productName) {
    const stop = new Set([
      'with', 'from', 'the', 'and', 'for', 'organic', 'filtered', 'fresh',
      'pack', 'count', 'ct', 'each',
    ]);
    return normalizeText(productName)
      .split(/[^a-z0-9%]+/)
      .filter((w) => w.length > 2 && !stop.has(w));
  }

  function dialogMatchesProduct(dialogEl, productName) {
    if (!productName || !dialogEl) return true;
    const text = normalizeText(dialogEl.textContent || '');
    const tokens = productMatchTokens(productName);
    if (!tokens.length) return true;
    const hits = tokens.filter((t) => text.includes(t));
    // Soft match: 1 strong token is enough when names reorder
    // ("Pepper Red Bell" vs "Red Bell Pepper").
    if (hits.length >= 1 && tokens.length <= 2) return true;
    if (tokens.length >= 2) return hits.length >= Math.min(2, tokens.length);
    return hits.length >= 1;
  }

  function isVisibleEl(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) {
      return true;
    }
  }

  /**
   * Locate the "IF OUT OF STOCK..." modal root.
   *
   * IMPORTANT (verified via console): the cart drawer is ALSO role="dialog"
   * with aria-label="Cart". Matching only on "best match" wrongly targets it.
   *
   * ALSO: Instacart may leave a previous item's modal in the DOM (or reuse a
   * portal that still shows milk). Always prefer roots that match productName.
   */
  function findSubDialogRoots(productName) {
    const roots = [];
    const push = (el) => {
      if (el && !roots.includes(el) && !isOurUi(el) && !isCartDrawerDialog(el)) {
        roots.push(el);
      }
    };

    document.querySelectorAll('[role="dialog"], [aria-modal="true"]').forEach((d) => {
      if (isOurUi(d) || isCartDrawerDialog(d)) return;
      if (!isVisibleEl(d)) return;
      const text = normalizeText(d.textContent);
      const looksLikeSubModal =
        text.includes('refund this item') &&
        (text.includes('if out of stock') ||
          text.includes('item will be refunded') ||
          text.includes('replace with specific item'));
      if (!looksLikeSubModal) return;
      if (productName && !dialogMatchesProduct(d, productName)) return;
      push(d);
    });

    if (roots.length) return roots;

    // Portal / non-dialog overlay: find "Refund this item" text, walk up.
    // If productName is set, only accept containers that also mention it.
    const refundLabel = findLabelElement([document.body], ['refund this item']);
    if (refundLabel && refundLabel.el) {
      let cur = refundLabel.el;
      for (let i = 0; i < 15 && cur && cur !== document.body; i++) {
        const t = normalizeText(cur.textContent);
        if (
          t.includes('refund this item') &&
          (t.includes('if out of stock') || t.includes('replace with best match')) &&
          (t.includes('save') || t.includes('item will be refunded'))
        ) {
          if (t.length < 8000 && isVisibleEl(cur)) {
            if (!productName || dialogMatchesProduct(cur, productName)) {
              push(cur);
              break;
            }
          }
        }
        cur = cur.parentElement;
      }
    }

    // Never fall back to document.body when we have a productName — that is
    // what caused "glitching back to milk" while editing another item.
    return roots;
  }

  /** Poll until a sub-dialog for this product is present. */
  async function waitForSubDialog(timeoutMs, productName) {
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      const roots = findSubDialogRoots(productName);
      if (roots.length) return roots;
      await wait(100);
    }
    return [];
  }

  /** Wait until leftover modals are gone (or timed out). */
  async function waitUntilNoSubDialog(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 1500);
    while (Date.now() < deadline) {
      // Any visible sub modal, regardless of product.
      if (!findSubDialogRoots(null).length) return true;
      await wait(100);
    }
    return !findSubDialogRoots(null).length;
  }

  /**
   * Close the out-of-stock modal.
   *
   * IMPORTANT: prefer Escape over clicking the X. A synthetic click on Close/Save
   * can "fall through" onto the cart item underneath (e.g. milk Save → suddenly
   * opens Red Bell Pepper). Only click the X when allowClick is true.
   */
  function dismissSubDialog(roots, allowClick) {
    log('Dismissing modal via Escape (avoids click-through onto cart items)');
    try {
      const active = document.activeElement;
      const target = active && active !== document.body ? active : document;
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch (_) {
      /* ignore */
    }

    if (!allowClick) return true;

    const scopes = roots && roots.length ? roots : findSubDialogRoots(null);
    for (const root of scopes) {
      if (!root || !root.querySelectorAll) continue;
      const candidates = root.querySelectorAll('button, [role="button"], [aria-label]');
      for (const el of candidates) {
        if (isOurUi(el)) continue;
        const aria = normalizeText(el.getAttribute('aria-label') || '');
        const textContent = normalizeText(el.textContent || '');
        if (aria === 'close' || aria.startsWith('close ')) {
          log('Dismissing modal via close button:', describeNode(el));
          simulateUserClick(el);
          return true;
        }
        if (textContent === '×' || textContent === 'x') {
          log('Dismissing modal via × control:', describeNode(el));
          simulateUserClick(el);
          return true;
        }
      }
    }
    return true;
  }

  async function finishSubChange(item, detail) {
    if (item && itemNoLongerBestMatch(item)) {
      removeBadge(item);
    }
    // Escape only after caller confirmed the setting stuck — never cancel an
    // unsaved milk refund by closing early.
    if (findSubDialogRoots(null).length) {
      dismissSubDialog(null, false);
      await waitUntilNoSubDialog(1500);
    }
    await wait(200);
    scheduleScan();
    return { ok: true, mode: 'native-option-saved', detail };
  }

  /** True if a refund / option row looks selected after our click. */
  function optionRowLooksSelected(row) {
    if (!row) return false;
    if (row.matches && row.matches('input[type="radio"]') && row.checked) return true;
    if (row.getAttribute && row.getAttribute('aria-checked') === 'true') return true;
    const checked = row.querySelector && row.querySelector(
      'input[type="radio"]:checked, [aria-checked="true"], [role="radio"][aria-checked="true"]'
    );
    if (checked) return true;
    // Heuristic: selected radios often use data-state / checked class names.
    const html = (row.outerHTML || '').toLowerCase();
    if (html.includes('aria-checked="true"') || html.includes(':checked')) return true;
    return false;
  }

  /**
   * Wait for option label, click it, retry until it looks selected.
   */
  async function selectDialogOption(searchRoots, preferredLabels) {
    let match = null;
    for (let i = 0; i < 25; i++) {
      match = findLabelElement(searchRoots, preferredLabels);
      if (match) break;
      await wait(100);
    }
    if (!match) return null;

    const row = findClickableOptionRow(match.el);
    log(
      'Selecting option:',
      match.text,
      '(pattern:',
      match.matchedPattern + ')',
      'click target:',
      describeNode(row)
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      simulateUserClick(row);
      const nestedRadio =
        (row &&
          row.querySelector &&
          row.querySelector('input[type="radio"], [role="radio"]')) ||
        null;
      if (nestedRadio && nestedRadio !== row) {
        simulateUserClick(nestedRadio);
      }
      await wait(300);
      if (optionRowLooksSelected(row) || optionRowLooksSelected(nestedRadio)) {
        log('Option appears selected on attempt', attempt);
        return match;
      }
      log('Option not visibly selected yet — retry', attempt);
    }

    // Return match anyway; Instacart may not expose checked state in DOM.
    return match;
  }

  // ---------------------------------------------------------------------------
  // Instacart interaction probe
  // ---------------------------------------------------------------------------

  /**
   * Clicks Instacart's own substitution button, selects an option in the
   * "IF OUT OF STOCK..." dialog, then clicks Save.
   *
   * Runs serialized (interactionChain) so milk's Save cannot overlap pepper.
   */
  async function interactWithInstacartSub(item, intent) {
    const run = () => interactWithInstacartSubUnlocked(item, intent);
    const waitForTurn = interactionChain.then(run, run);
    // Keep the chain alive regardless of success/failure.
    interactionChain = waitForTurn.then(
      () => undefined,
      () => undefined
    );
    return waitForTurn;
  }

  async function interactWithInstacartSubUnlocked(item, intent) {
    const productName = productKey(item);

    if (intent === 'dont-replace' && itemAlreadyRefund(item)) {
      log('Cart row already shows refund — clearing badge / Escape leftover modal.');
      hidePopoverForNativeUi();
      dismissSubDialog(null, false);
      await waitUntilNoSubDialog(1200);
      return finishSubChange(item, 'Already set to refund — cleared extension badge.');
    }

    const subButton = findSubButton(item);
    if (!subButton) {
      warn('No Instacart sub button found inside item — cannot drive native UI.');
      return {
        ok: false,
        mode: 'missing-button',
        detail: 'Could not find Instacart substitution button in this item.',
      };
    }

    hidePopoverForNativeUi();
    await wait(50);

    // Close leftovers with Escape only (no X click → no fall-through onto pepper).
    if (findSubDialogRoots(null).length) {
      log('Escape-dismissing leftover modal before opening:', productName);
      dismissSubDialog(null, false);
      await waitUntilNoSubDialog(1800);
    }

    log('Clicking Instacart substitution button for:', productName);
    log('Button:', describeNode(subButton));
    simulateUserClick(subButton);

    // Prefer a product-matched dialog; if name matching is flaky (pepper vs
    // "Red Bell Pepper"), fall back to the single visible sub-dialog.
    let dialogs = await waitForSubDialog(3000, productName);
    if (!dialogs.length) {
      log('No product-matched dialog yet — accepting sole visible sub-dialog if any');
      for (let i = 0; i < 15; i++) {
        const any = findSubDialogRoots(null);
        if (any.length === 1) {
          // Reject if it clearly belongs to a *different* cart product.
          const otherHit = Array.from(
            document.querySelectorAll('[role="group"][aria-label]')
          ).some((g) => {
            const name = g.getAttribute('aria-label') || '';
            if (!name || name === productName) return false;
            return dialogMatchesProduct(any[0], name) && !dialogMatchesProduct(any[0], productName);
          });
          if (!otherHit) {
            dialogs = any;
            break;
          }
        }
        if (any.length && dialogMatchesProduct(any[0], productName)) {
          dialogs = any;
          break;
        }
        await wait(100);
      }
    }

    if (!dialogs.length) {
      warn('Timed out waiting for substitution dialog for:', productName);
      return {
        ok: false,
        mode: 'no-menu-detected',
        detail:
          'Opened substitution control but did not get a dialog for this product.',
      };
    }

    log('Using dialog root(s) for', productName, ':', dialogs.length);
    const searchRoots = dialogs;

    if (!intent) {
      return {
        ok: true,
        mode: 'menu-opened',
        detail: 'Opened Instacart UI; no option selected (probe only).',
      };
    }

    const preferredLabels =
      intent === 'dont-replace'
        ? ['refund this item', ...DONT_REPLACE_PATTERNS]
        : ['replace with specific item', ...SPECIFIC_REPLACEMENT_PATTERNS];

    const match = await selectDialogOption(searchRoots, preferredLabels);
    if (!match) {
      warn('Could not find/select option for', intent, preferredLabels);
      return {
        ok: false,
        mode: 'option-not-found',
        detail:
          intent === 'dont-replace'
            ? 'Dialog opened but could not select "Refund this item".'
            : 'Dialog opened but could not select "Replace with specific item".',
      };
    }

    // Give React a beat to enable Save / update radio UI.
    await wait(350);

    if (intent === 'specific') {
      const saveBtn = await waitForEnabledSave(searchRoots, match.el, 1500);
      if (saveBtn) {
        await clickSaveRobustly(saveBtn);
      }
      scheduleScan();
      return {
        ok: true,
        mode: 'native-option-saved',
        detail: `Selected "${match.text}". Use Instacart’s carousel / Save if needed.`,
      };
    }

    // dont-replace path — milk is the hard case: tall carousel pushes Save
    // below the fold. Never Escape until the cart row confirms refund, or we
    // cancel the selection and it looks like "milk won't refund".
    const saveBtn = await waitForEnabledSave(searchRoots, match.el, 2500);
    if (!saveBtn) {
      warn('No Save button found after selecting refund — leaving modal open.');
      return {
        ok: false,
        mode: 'save-not-found',
        detail:
          'Refund should be highlighted — scroll to the bottom of the Instacart modal and tap Save.',
      };
    }

    log('Clicking Save for:', productName);
    await clickSaveRobustly(saveBtn);

    for (let i = 0; i < 24; i++) {
      if (itemNoLongerBestMatch(item)) {
        log('Cart row confirmed leave-best-match after Save (tick', i + ')');
        // Only now is Escape safe — setting already persisted.
        await wait(250);
        if (findSubDialogRoots(null).length) {
          dismissSubDialog(null, false);
          await waitUntilNoSubDialog(1200);
        }
        return finishSubChange(
          item,
          `Selected "${match.text}" and saved — cart no longer on best match.`
        );
      }

      // Dialog closed without cart update yet — give SPA a moment.
      if (!findSubDialogRoots(null).length) {
        await wait(400);
        if (itemNoLongerBestMatch(item)) {
          return finishSubChange(
            item,
            `Selected "${match.text}" and saved — cart no longer on best match.`
          );
        }
        break;
      }

      // Still open + still best-match: retry Save (common for milk).
      if (i === 6 || i === 12 || i === 18) {
        log('Cart still on best match — retrying Save');
        const again = await waitForEnabledSave(searchRoots, match.el, 500);
        if (again) await clickSaveRobustly(again);
      }
      await wait(150);
    }

    if (itemNoLongerBestMatch(item)) {
      return finishSubChange(
        item,
        `Selected "${match.text}" and saved — cart no longer on best match.`
      );
    }

    // Do NOT Escape — that cancels an unsaved refund on milk.
    warn(
      'Refund selected but cart row still shows best match — leaving modal open for manual Save.'
    );
    return {
      ok: false,
      mode: 'save-unconfirmed',
      detail:
        'Refund is selected in the modal but not saved yet — tap Instacart’s green Save (you may need to scroll down on milk).',
    };
  }

  // ---------------------------------------------------------------------------
  // Personal notes (local only — NOT sent to Instacart / shopper)
  // ---------------------------------------------------------------------------

  /**
   * LIMITATION (intentional honesty):
   * Instacart does not expose a public API for "please get THIS specific
   * backup" from an extension, and we may not find a native picker to hook.
   * Notes saved here live only in chrome.storage.local on THIS browser
   * profile. They are a personal reminder layer for the customer — they are
   * NOT transmitted to the shopper or Instacart. The UI labels them as such.
   */
  function loadNotes() {
    if (!chrome.storage || !chrome.storage.local) {
      warn('chrome.storage.local unavailable — notes disabled.');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      chrome.storage.local.get([NOTES_STORAGE_KEY], (result) => {
        notesByProduct = result[NOTES_STORAGE_KEY] || {};
        log('Loaded personal notes for', Object.keys(notesByProduct).length, 'product(s)');
        resolve();
      });
    });
  }

  function persistNotes() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [NOTES_STORAGE_KEY]: notesByProduct }, resolve);
    });
  }

  async function saveNote(productName, noteText) {
    const key = (productName || '').trim();
    const text = (noteText || '').trim();
    if (!key) return;
    if (text) {
      notesByProduct[key] = text;
    } else {
      delete notesByProduct[key];
    }
    await persistNotes();
    scheduleScan();
  }

  // ---------------------------------------------------------------------------
  // Badge + note badge injection (idempotent under MutationObserver re-scans)
  // ---------------------------------------------------------------------------

  function ensureBadge(item, productName) {
    let badge = item.querySelector(':scope > .' + BADGE_CLASS);
    if (!badge) {
      // Use a <button> so it's keyboard-accessible and clearly interactive.
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = BADGE_CLASS;
      badge.setAttribute('data-sub-spotlight-action', 'open-popover');
      item.prepend(badge);
    }

    badge.textContent = '⚠ Auto-substitute: best match ▾';
    badge.title =
      (productName || 'This item') +
      ' will be auto-replaced if out of stock. Click to change setting or add a note.';
    item.setAttribute(PROCESSED_ATTR, 'true');
  }

  function removeBadge(item) {
    const badge = item.querySelector(':scope > .' + BADGE_CLASS);
    if (badge) badge.remove();
    item.removeAttribute(PROCESSED_ATTR);
  }

  function ensureNoteBadge(item, productName) {
    const note = notesByProduct[productName];
    let noteBadge = item.querySelector(':scope > .' + NOTE_BADGE_CLASS);

    if (!note) {
      if (noteBadge) noteBadge.remove();
      return;
    }

    if (!noteBadge) {
      noteBadge = document.createElement('div');
      noteBadge.className = NOTE_BADGE_CLASS;
      noteBadge.setAttribute('data-sub-spotlight-action', 'open-popover');
      // Place after the auto-sub badge if present, else at top.
      const autoBadge = item.querySelector(':scope > .' + BADGE_CLASS);
      if (autoBadge && autoBadge.nextSibling) {
        item.insertBefore(noteBadge, autoBadge.nextSibling);
      } else if (autoBadge) {
        autoBadge.after(noteBadge);
      } else {
        item.prepend(noteBadge);
      }
    }

    noteBadge.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'sub-spotlight-note-label';
    label.textContent = 'Your note: ' + note;
    noteBadge.appendChild(label);

    const disclaimer = document.createElement('span');
    disclaimer.className = 'sub-spotlight-note-disclaimer';
    disclaimer.textContent =
      ' Personal reminder only — not sent to the shopper.';
    noteBadge.appendChild(disclaimer);
    noteBadge.title =
      'Local reminder saved by Substitution Spotlight. Instacart does not receive this note.';
  }

  function updatePanel(count) {
    let panel = document.getElementById(PANEL_ID);
    if (count === 0) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.title = 'Click to collapse/expand';
      panel.addEventListener('click', () => {
        panel.classList.toggle('sub-spotlight-collapsed');
        // Refresh label for collapsed/expanded state
        const n = Number(panel.dataset.count || count);
        applyPanelText(panel, n);
      });
      document.body.appendChild(panel);
    }
    panel.dataset.count = String(count);
    applyPanelText(panel, count);
  }

  function applyPanelText(panel, count) {
    const fullText =
      count +
      ' item' +
      (count === 1 ? '' : 's') +
      ' on auto "best match" substitution';
    panel.dataset.fullText = fullText;
    panel.textContent = panel.classList.contains('sub-spotlight-collapsed')
      ? count + ' auto-sub'
      : fullText;
  }

  // ---------------------------------------------------------------------------
  // Custom popover UI (ours — not Instacart's)
  // ---------------------------------------------------------------------------

  function closePopover() {
    const existing = document.getElementById(POPOVER_ID);
    if (existing) existing.remove();
  }

  /** Temporarily hide our popover so it doesn't cover Instacart's modal. */
  function hidePopoverForNativeUi() {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop) return null;
    pop.style.visibility = 'hidden';
    pop.style.pointerEvents = 'none';
    return pop;
  }

  function showPopoverAgain(pop) {
    if (!pop || !pop.isConnected) return;
    pop.style.visibility = '';
    pop.style.pointerEvents = '';
  }

  function setPopoverStatus(popover, message, kind) {
    let status = popover.querySelector('.sub-spotlight-popover-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'sub-spotlight-popover-status';
      popover.appendChild(status);
    }
    status.textContent = message || '';
    status.dataset.kind = kind || 'info';
    status.hidden = !message;
  }

  /**
   * Opens our popover anchored near the badge for a given cart item.
   * Options:
   *  1. Best match (current) — closes only; already the live setting
   *  2. Don't replace — drives Instacart's native control via probe
   *  3. Specific backup — tries native picker; else local note field
   */
  function openPopover(item, anchorEl) {
    closePopover();

    const productName = productKey(item);
    const existingNote = notesByProduct[productName] || '';

    const popover = document.createElement('div');
    popover.id = POPOVER_ID;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Change substitution setting');

    const heading = document.createElement('div');
    heading.className = 'sub-spotlight-popover-heading';
    heading.textContent = productName || 'Substitution options';
    popover.appendChild(heading);

    // --- Option 1: keep best match ---
    const btnBest = document.createElement('button');
    btnBest.type = 'button';
    btnBest.className = 'sub-spotlight-popover-option';
    btnBest.textContent = 'Best match (current)';
    btnBest.addEventListener('click', () => {
      closePopover();
    });
    popover.appendChild(btnBest);

    // --- Option 2: don't replace (native) ---
    const btnDont = document.createElement('button');
    btnDont.type = 'button';
    btnDont.className = 'sub-spotlight-popover-option';
    btnDont.textContent = "Don't replace — refund me instead";
    btnDont.addEventListener('click', async () => {
      btnDont.disabled = true;
      setPopoverStatus(popover, 'Talking to Instacart’s control…', 'info');
      const result = await interactWithInstacartSub(item, 'dont-replace');
      if (result.ok) {
        closePopover();
        log('Native refund preference applied:', result.detail);
      } else {
        showPopoverAgain(popover);
        setPopoverStatus(popover, result.detail, 'error');
        btnDont.disabled = false;
      }
    });
    popover.appendChild(btnDont);

    // --- Option 3: specific backup ---
    const specificWrap = document.createElement('div');
    specificWrap.className = 'sub-spotlight-popover-specific';

    const btnSpecific = document.createElement('button');
    btnSpecific.type = 'button';
    btnSpecific.className = 'sub-spotlight-popover-option';
    btnSpecific.textContent = 'Let me pick a specific backup';
    specificWrap.appendChild(btnSpecific);

    const noteHint = document.createElement('p');
    noteHint.className = 'sub-spotlight-popover-hint';
    noteHint.textContent =
      'If Instacart opens a picker, use that. Otherwise this saves a personal reminder on this device only — it is NOT sent to the shopper.';
    specificWrap.appendChild(noteHint);

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'sub-spotlight-popover-input';
    noteInput.placeholder = 'e.g. get the 2% organic version instead';
    noteInput.value = existingNote;
    noteInput.setAttribute('aria-label', 'Personal backup preference note');
    specificWrap.appendChild(noteInput);

    const noteActions = document.createElement('div');
    noteActions.className = 'sub-spotlight-popover-note-actions';

    const btnSaveNote = document.createElement('button');
    btnSaveNote.type = 'button';
    btnSaveNote.className = 'sub-spotlight-popover-save';
    btnSaveNote.textContent = 'Save personal note';
    btnSaveNote.addEventListener('click', async () => {
      await saveNote(productName, noteInput.value);
      setPopoverStatus(
        popover,
        noteInput.value.trim()
          ? 'Saved locally (reminder only — not sent to Instacart).'
          : 'Cleared local note.',
        'ok'
      );
      await wait(600);
      closePopover();
    });
    noteActions.appendChild(btnSaveNote);

    const btnClearNote = document.createElement('button');
    btnClearNote.type = 'button';
    btnClearNote.className = 'sub-spotlight-popover-clear';
    btnClearNote.textContent = 'Clear note';
    btnClearNote.addEventListener('click', async () => {
      noteInput.value = '';
      await saveNote(productName, '');
      setPopoverStatus(popover, 'Cleared local note.', 'ok');
      await wait(500);
      closePopover();
    });
    noteActions.appendChild(btnClearNote);
    specificWrap.appendChild(noteActions);

    btnSpecific.addEventListener('click', async () => {
      btnSpecific.disabled = true;
      setPopoverStatus(
        popover,
        'Looking for Instacart’s “specific replacement” control…',
        'info'
      );
      const result = await interactWithInstacartSub(item, 'specific');
      // Re-show our popover beside Instacart’s picker so the local-note
      // field stays available (native “specific” still needs a product tap).
      showPopoverAgain(popover);
      if (result.ok) {
        setPopoverStatus(
          popover,
          result.detail +
            ' Pick a product in Instacart’s carousel; you can also save a local note below.',
          'ok'
        );
      } else {
        setPopoverStatus(
          popover,
          result.detail +
            ' No native picker hooked — use the text field below as a personal reminder.',
          'error'
        );
        noteInput.focus();
      }
      btnSpecific.disabled = false;
    });

    popover.appendChild(specificWrap);

    // Position near the badge (fixed, so SPA scroll/layout is less painful).
    document.body.appendChild(popover);
    const rect = anchorEl.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;

    // Keep inside viewport.
    if (left + popRect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - popRect.width - 8);
    }
    if (top + popRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popRect.height - 6);
    }
    popover.style.top = Math.round(top) + 'px';
    popover.style.left = Math.round(left) + 'px';

    log('Opened extension popover for:', productName);
  }

  // ---------------------------------------------------------------------------
  // Scan (MutationObserver-driven)
  // ---------------------------------------------------------------------------

  function scan() {
    // Every cart item lives inside a role="group" container labeled with
    // the product name via aria-label — that's our stable per-item anchor.
    const items = document.querySelectorAll('[role="group"][aria-label]');
    let flaggedCount = 0;

    items.forEach((item) => {
      const productName = productKey(item);
      const subButton = findSubButton(item);

      if (subButton) {
        ensureBadge(item, productName);
        flaggedCount++;
      } else {
        // Setting is no longer "best match" (user changed it, or never was).
        // Remove our auto-sub badge so we don't lie about the live setting.
        removeBadge(item);
      }

      // Notes can appear on any item, not only best-match ones.
      if (productName) {
        ensureNoteBadge(item, productName);
      }
    });

    updatePanel(flaggedCount);
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 400);
  }

  // ---------------------------------------------------------------------------
  // Global listeners (event delegation — survives SPA re-renders)
  // ---------------------------------------------------------------------------

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      // Clicks inside our popover should not dismiss it via the outside handler.
      if (target.closest('#' + POPOVER_ID)) {
        return;
      }

      const actionEl = target.closest('[data-sub-spotlight-action="open-popover"]');
      if (actionEl) {
        event.preventDefault();
        event.stopPropagation();
        const item = actionEl.closest('[role="group"][aria-label]');
        if (item) {
          openPopover(item, actionEl);
        }
        return;
      }

      // Outside click closes popover.
      if (document.getElementById(POPOVER_ID)) {
        closePopover();
      }
    },
    true
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePopover();
    }
  });

  // Instacart's cart is a single-page app — content loads/re-renders
  // dynamically, so we watch for DOM changes instead of scanning once.
  // Ignore mutations we ourselves cause inside the popover / panel to
  // reduce scan thrash (still debounced either way).
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const t = m.target;
      if (!(t instanceof Element)) return true;
      if (t.closest('#' + POPOVER_ID + ', #' + PANEL_ID)) return false;
      if (
        t.classList &&
        (t.classList.contains(BADGE_CLASS) || t.classList.contains(NOTE_BADGE_CLASS))
      ) {
        return false;
      }
      return true;
    });
    if (relevant) scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Boot
  loadNotes().then(() => {
    log('Content script ready. Click a yellow badge to change substitution / add a note.');
    log(
      'When you choose "Don\'t replace", watch this console for probe logs of Instacart\'s menu DOM.'
    );
    scheduleScan();
  });
})();
