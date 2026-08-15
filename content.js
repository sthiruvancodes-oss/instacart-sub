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
  const GUIDE_CLASS = 'sub-spotlight-guide';
  const PULSE_CLASS = 'sub-spotlight-pulse';
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
  const SUB_BUTTON_PATTERNS = [
    'best match',
    'replace with best',
    'similar item',
    'find similar',
  ];

  const BEST_MATCH_OPTION_PHRASES = [
    'replace with best match',
    'find similar item',
    'similar item',
  ];

  /**
   * Text patterns for the native refund / no-sub option inside Instacart's
   * substitution dialog. Ordered most-specific first.
   * VERIFIED (2026-08 instacart.ca): "Refund, don't replace"
   * Older copy: "Refund this item"
   */
  const DONT_REPLACE_PATTERNS = [
    "refund, don't replace",
    'refund, dont replace',
    "don't replace",
    'dont replace',
    'refund this item',
    'refund me',
    'refund instead',
    'do not replace',
    'no substitution',
    'no replacements',
  ];

  /** Phrases used to find the visible refund radio in the live modal. */
  const REFUND_OPTION_PHRASES = [
    "refund, don't replace",
    'refund, dont replace',
    'refund this item',
  ];

  /** Fingerprints of Instacart's substitution modal (title changed across deploys). */
  const SUB_MODAL_TITLE_PHRASES = [
    'replacement preference',
    'if out of stock',
  ];

  /**
   * Patterns for Instacart's "pick a specific replacement" radio.
   * VERIFIED label on instacart.ca: "Replace with specific item"
   * Prefer the full phrase so we don't accidentally match carousel
   * product tiles that merely contain the word "specific".
   */
  const SPECIFIC_REPLACEMENT_PATTERNS = [
    'replace with specific item',
    'replacement chosen',
    'specific item',
    'chosen replacement',
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
  let interactionGen = 0;
  let ignoreProgrammaticInput = false;
  /** Cart item the open popover belongs to (re-resolved by product name if the row re-renders). */
  let activePopoverItem = null;
  let activePopoverProduct = '';

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
      // Preference modal is nested in the cart item — do not treat its
      // "Replace with best match" copy as the cart-row control.
      if (b.closest('[role="radiogroup"]')) continue;
      if (b.closest('[data-testid="row-base"]')) continue;
      const text = (b.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (text.length > 140) continue;
      if (text === 'save') continue;
      if (SUB_BUTTON_PATTERNS.some((p) => text.includes(p))) {
        return b;
      }
    }
    return null;
  }

  function cartRowControlText(el) {
    if (!el) return '';
    return normalizeText(el.textContent || el.getAttribute('aria-label') || '');
  }

  function isIgnoredSubNode(el) {
    if (!el || isOurUi(el)) return true;
    if (el.closest('[role="radiogroup"], [data-testid="row-base"]')) return true;
    return false;
  }

  function settingControlCandidates(item) {
    if (!item) return [];
    const out = [];
    const seen = new Set();
    const nodes = [
      ...item.querySelectorAll('button[type="submit"]'),
      ...item.querySelectorAll('button'),
    ];
    for (const b of nodes) {
      if (seen.has(b) || isIgnoredSubNode(b)) continue;
      seen.add(b);
      const text = cartRowControlText(b);
      if (text === 'save') continue;
      if (/^[+\-−]$/.test(text) || /^\d+$/.test(text)) continue;
      if (text === 'remove' || text.startsWith('remove ')) continue;
      out.push(b);
    }
    return out;
  }

  function textHasBestMatch(text) {
    const t = normalizeText(text);
    return !!t && SUB_BUTTON_PATTERNS.some((p) => t.includes(p));
  }

  /**
   * Cart-row substitution control (best match, refund, or specific).
   * Do not treat random product-card buttons as a setting — that painted
   * "Specific replacement" all over search results.
   */
  function findCartRowSubControl(item) {
    if (!item) return null;
    const candidates = settingControlCandidates(item);
    const refund = candidates.find(rowLooksLikeRefund);
    if (refund) return refund;
    const specific = candidates.find(rowLooksLikeSpecific);
    if (specific) return specific;
    const best = candidates.find(rowLooksLikeBestMatch) || findSubButton(item);
    if (best) return best;
    return leftoverSettingSubmit(item);
  }

  function leftoverSettingSubmit(item) {
    const submits = settingControlCandidates(item).filter((b) => {
      if (b.type !== 'submit' && b.getAttribute('type') !== 'submit') return false;
      if (rowLooksLikeBestMatch(b) || rowLooksLikeRefund(b)) return false;
      return true;
    });
    return submits.length === 1 ? submits[0] : null;
  }

  function rowLooksLikeRefund(el) {
    const text = cartRowControlText(el);
    return (
      !!text &&
      (text.includes("refund, don't replace") ||
        text.includes('refund this item') ||
        text.includes('refund, dont replace'))
    );
  }

  function rowLooksLikeBestMatch(el) {
    const text = cartRowControlText(el);
    if (!text || text.includes('specific')) return false;
    return textHasBestMatch(text);
  }

  function rowLooksLikeSpecific(el) {
    const text = cartRowControlText(el);
    if (!text || text.length > 500) return false;
    if (rowLooksLikeRefund(el) || rowLooksLikeBestMatch(el)) return false;
    return (
      text.includes('replacement chosen') ||
      text.includes('specific item') ||
      text.includes('specific replacement') ||
      text.includes('chosen replacement') ||
      text.includes('your replacement') ||
      text.includes('selected replacement') ||
      (text.startsWith('replace with ') && !textHasBestMatch(text))
    );
  }

  function itemHasSettingPhrase(item, phrases) {
    if (!item) return false;
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (isOurUi(node.parentElement)) continue;
      const t = normalizeText(node.nodeValue);
      if (!t || t.length > 80) continue;
      if (phrases.some((p) => t === p || t.includes(p))) return true;
    }
    return false;
  }

  function looksLikeCartLine(item) {
    if (!item) return false;
    if (findSubButton(item) || itemAlreadyRefund(item)) return true;
    if (
      itemHasSettingPhrase(item, [
        "refund, don't replace",
        'refund this item',
        'replacement chosen',
        'replace with best match',
        'replace with specific item',
      ])
    ) {
      return true;
    }
    const candidates = settingControlCandidates(item);
    if (candidates.some((b) => rowLooksLikeRefund(b) || rowLooksLikeBestMatch(b) || rowLooksLikeSpecific(b))) {
      return true;
    }
    const qty = item.querySelector(
      'input[type="number"], [aria-label*="quantity" i], [aria-label*="Quantity"]'
    );
    if (qty) return true;
    let inc = false;
    let dec = false;
    const buttons = item.querySelectorAll('button');
    for (const b of buttons) {
      if (isOurUi(b)) continue;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim();
      if (t === '+' || /increase|increment|add one/.test(aria)) inc = true;
      if (t === '−' || t === '-' || /decrease|decrement|minus|remove one/.test(aria)) {
        dec = true;
      }
    }
    return inc && dec;
  }

  /** Skip nested product groups (replacement thumbnail, search cards, etc.). */
  function isNestedReplacementGroup(item) {
    const parent =
      item && item.parentElement && item.parentElement.closest('[role="group"][aria-label]');
    if (!parent || parent === item) return false;
    return looksLikeCartLine(parent);
  }

  function classifyCartItem(item) {
    if (!item || !looksLikeCartLine(item)) return null;
    if (itemAlreadyRefund(item)) return 'refund';
    const candidates = settingControlCandidates(item);
    if (
      candidates.some(rowLooksLikeRefund) ||
      itemHasSettingPhrase(item, ["refund, don't replace", 'refund this item', 'refund, dont replace'])
    ) {
      return 'refund';
    }
    if (
      candidates.some(rowLooksLikeSpecific) ||
      itemHasSettingPhrase(item, [
        'replacement chosen',
        'replace with specific item',
        'chosen replacement',
      ])
    ) {
      return 'specific';
    }
    if (findSubButton(item) || candidates.some(rowLooksLikeBestMatch)) return 'best';
    if (leftoverSettingSubmit(item)) return 'specific';
    return null;
  }

  function preferenceModalOpen() {
    if (document.querySelector('[role="radiogroup"][aria-label="Select"]')) return true;
    return !!findPreferenceRadiogroup();
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
      if (el.closest('[role="radiogroup"]')) continue;
      if (el.closest('[data-testid="row-base"]')) continue;
      const text = normalizeText(el.textContent || el.getAttribute('aria-label') || '');
      if (!text || text.length > 80) continue;
      if (
        text.includes('refund this item') ||
        text.includes("refund, don't replace") ||
        text.includes('refund, dont replace') ||
        text === 'refund'
      ) {
        return true;
      }
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
    return (text || '')
      .replace(/\s+/g, ' ')
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .trim()
      .toLowerCase();
  }

  function isOurUi(el) {
    return !!(
      el &&
      el.closest &&
      el.closest(
        '#' +
          POPOVER_ID +
          ', #' +
          PANEL_ID +
          ', .' +
          BADGE_CLASS +
          ', .' +
          NOTE_BADGE_CLASS +
          ', .' +
          GUIDE_CLASS
      )
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

  function clickPointFor(el) {
    if (!el || !el.getBoundingClientRect) return null;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (r.width < 2 || r.height < 2) return null;
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + Math.min(14, Math.max(4, r.height / 2)));
    if (x < 8 || y < 8 || x > window.innerWidth - 8 || y > window.innerHeight - 8) {
      return null;
    }
    const dialog = el.closest && el.closest('[role="dialog"], [aria-modal="true"]');
    if (dialog) {
      const d = dialog.getBoundingClientRect();
      if (x < d.left + 4 || x > d.right - 4 || y < d.top + 4 || y > d.bottom - 4) {
        return null;
      }
    }
    return { x, y };
  }

  /**
   * Pointer/mouse sequence for in-modal cards (not the cart-row submit).
   * Register preventDefault on submit *before* dispatch — after is a no-op.
   * Never dispatch at (0,0) or off-screen — Instacart treats that as
   * "click outside the cart" and closes the drawer.
   */
  function simulateUserClick(el, clickOpts) {
    if (!el) return false;
    const point = clickPointFor(el);
    if (!point) {
      log('Refusing off-screen click for', describeNode(el));
      return false;
    }
    ignoreProgrammaticInput = true;
    const blockSubmit = !(clickOpts && clickOpts.preventSubmit === false);
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
    };

    const isSubmit =
      (el.tagName === 'BUTTON' && (el.type === 'submit' || el.type === '')) ||
      (el.tagName === 'INPUT' && el.type === 'submit');
    const preventSubmit = (e) => {
      e.preventDefault();
    };
    if (isSubmit && blockSubmit) {
      try {
        el.addEventListener('click', preventSubmit, true);
      } catch (_) {
        /* ignore */
      }
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

    if (isSubmit && blockSubmit) {
      try {
        el.removeEventListener('click', preventSubmit, true);
      } catch (_) {
        /* ignore */
      }
    }

    if (el.tagName === 'INPUT' && el.type === 'radio') {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    setTimeout(() => {
      ignoreProgrammaticInput = false;
    }, 0);

    return true;
  }

  /**
   * Open Instacart's Replacement preference from a *user click* on our menu.
   * Must run in the same turn as that click (no await before this) or Chrome
   * drops user-activation and the cart drawer treats it as dismiss.
   *
   * type=submit + untrusted click submits the cart form. Flip to type=button
   * for the activation, keep preventDefault on, then restore.
   */
  function activateNativeSubControl(el) {
    if (!el) return false;
    ignoreProgrammaticInput = true;
    const prevTypeAttr = el.getAttribute('type');
    const wasSubmit =
      el.tagName === 'BUTTON' && (el.type === 'submit' || el.type === '');
    if (wasSubmit) {
      try {
        el.setAttribute('type', 'button');
      } catch (_) {
        /* ignore */
      }
    }
    const preventSubmit = (e) => {
      e.preventDefault();
    };
    try {
      el.addEventListener('click', preventSubmit, true);
    } catch (_) {
      /* ignore */
    }

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
      opts.clientX = Math.round(r.left + r.width / 2);
      opts.clientY = Math.round(r.top + r.height / 2);
    } catch (_) {
      /* ignore */
    }
    const events = [
      ['pointerdown', PointerEvent],
      ['mousedown', MouseEvent],
      ['pointerup', PointerEvent],
      ['mouseup', MouseEvent],
    ];
    for (const [type, Ctor] of events) {
      try {
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_) {
        /* ignore */
      }
    }
    try {
      el.click();
    } catch (_) {
      /* ignore */
    }

    try {
      el.removeEventListener('click', preventSubmit, true);
    } catch (_) {
      /* ignore */
    }
    if (wasSubmit) {
      try {
        if (prevTypeAttr == null) el.removeAttribute('type');
        else el.setAttribute('type', prevTypeAttr);
      } catch (_) {
        /* ignore */
      }
    }
    setTimeout(() => {
      ignoreProgrammaticInput = false;
    }, 0);
    log('Activated Instacart substitution control (same-turn):', describeNode(el));
    return true;
  }

  /**
   * Scroll the control on-screen, then click the actual hit-target at its
   * center. Off-screen radios/Save (tall milk carousel) otherwise get a
   * synthetic click that never reaches Instacart's handler.
   */
  async function clickVisible(el) {
    if (!el) return false;
    if (!clickPointFor(el)) {
      log('Skipping off-screen pointer-click for', describeNode(el));
      return false;
    }
    simulateUserClick(el);
    return true;
  }

  /**
   * How July's refund click worked: HTMLElement.click() on the option node.
   * No pointerdown / clientX / clientY — those are what Instacart uses to
   * decide "outside the cart" when refund sits below the fold.
   */
  function clickOptionNode(el) {
    if (!el) return false;
    ignoreProgrammaticInput = true;
    log('Option .click() on', describeNode(el));
    try {
      if (typeof el.click === 'function') el.click();
    } catch (_) {
      /* ignore */
    }
    try {
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      );
    } catch (_) {
      /* ignore */
    }
    if (el.tagName === 'INPUT' && el.type === 'radio') {
      try {
        el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {
        /* ignore */
      }
    }
    setTimeout(() => {
      ignoreProgrammaticInput = false;
    }, 0);
    return true;
  }

  /**
   * VERIFIED (2026-08 DevTools): options live in
   *   [role="radiogroup"][aria-label="Select"]
   *     > div  (Replace with best match)
   *     > div  (Replace with specific item)
   *     > div  (Refund, don't replace)  ← click this, ~64px tall
   *         [data-testid="row-base"]
   * CSS class hashes (e-d76945) are unstable — do not use them.
   */
  function findPreferenceRadiogroup() {
    const seen = new Set();
    const groups = [
      ...document.querySelectorAll('[role="radiogroup"][aria-label="Select"]'),
      ...document.querySelectorAll('[role="radiogroup"]'),
    ];
    for (const g of groups) {
      if (seen.has(g) || isOurUi(g) || !isVisibleEl(g)) continue;
      seen.add(g);
      const t = normalizeText(g.textContent);
      if (!t.includes('replace with best match') && !t.includes('similar item')) continue;
      if (
        t.includes("refund, don't replace") ||
        t.includes('refund this item') ||
        t.includes('replace with specific item')
      ) {
        return g;
      }
    }
    return null;
  }

  function radiogroupOption(group, phrases) {
    if (!group) return null;
    const needles = (phrases || []).map(normalizeText).filter(Boolean);
    const kids = Array.from(group.children).filter((el) => el.nodeType === 1);
    for (const kid of kids) {
      const t = normalizeText(kid.textContent);
      if (needles.some((n) => t.includes(n))) return kid;
    }
    for (const r of group.querySelectorAll('[role="radio"]')) {
      const t = normalizeText(r.textContent);
      if (needles.some((n) => t.includes(n))) return r;
    }
    return null;
  }

  function refundRadiogroupSelected(group) {
    const refund = radiogroupOption(group, REFUND_OPTION_PHRASES);
    const best = radiogroupOption(group, ['replace with best match']);
    if (!refund) return false;
    if (
      refund.getAttribute('aria-checked') === 'true' ||
      refund.getAttribute('aria-selected') === 'true'
    ) {
      return true;
    }
    const inner =
      refund.querySelector &&
      refund.querySelector(
        '[aria-checked="true"], [role="radio"][aria-checked="true"], input[type="radio"]:checked'
      );
    if (inner) return true;
    if (best && refund !== best) {
      return selectionScore(refund) > selectionScore(best) + 1;
    }
    return false;
  }

  function bestRadiogroupSelected(group) {
    const refund = radiogroupOption(group, REFUND_OPTION_PHRASES);
    const best = radiogroupOption(group, BEST_MATCH_OPTION_PHRASES);
    if (!best) return false;
    if (
      best.getAttribute('aria-checked') === 'true' ||
      best.getAttribute('aria-selected') === 'true'
    ) {
      return true;
    }
    const inner =
      best.querySelector &&
      best.querySelector(
        '[aria-checked="true"], [role="radio"][aria-checked="true"], input[type="radio"]:checked'
      );
    if (inner) return true;
    if (refund && best !== refund) {
      return selectionScore(best) > selectionScore(refund) + 1;
    }
    return selectionScore(best) > 2;
  }

  async function waitForPreferenceRadiogroup(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      const g = findPreferenceRadiogroup();
      if (g) return g;
      await wait(100);
    }
    return findPreferenceRadiogroup();
  }

  function findPhraseInRoot(root, phrases, maxLen) {
    if (!root || !root.querySelectorAll) return null;
    const needles = (phrases || []).map(normalizeText).filter(Boolean);
    let best = null;
    let bestScore = Infinity;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (isOurUi(el)) continue;
      const t = normalizeText(el.textContent);
      if (!t || t.length > (maxLen || 90)) continue;
      const hit = needles.find((n) => t === n || t.startsWith(n));
      if (!hit) continue;
      const score = t.length + (t === hit ? -100 : 0);
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Save lives in the replacement-preference modal, which is often nested
   * inside the cart drawer (role=dialog aria-label=Cart). Do NOT skip cart
   * items here — that was why Tide showed "Save was not visible".
   */
  function findVisibleSaveButton(roots) {
    const seen = new Set();
    const candidates = [];

    const collect = (root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('button, [role="button"], input[type="submit"]').forEach((b) => {
        if (seen.has(b) || isOurUi(b)) return;
        seen.add(b);
        candidates.push(b);
      });
    };

    (roots || []).forEach(collect);
    document.querySelectorAll('[role="dialog"], [aria-modal="true"]').forEach(collect);
    collect(document.body);

    let exactEnabled = null;
    let exactDisabled = null;
    let inModal = null;

    for (const b of candidates) {
      const text = normalizeText(b.textContent || b.value || b.getAttribute('aria-label') || '');
      if (text !== 'save') continue;
      if (!isVisibleEl(b)) continue;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') {
        exactDisabled = exactDisabled || b;
        continue;
      }
      if (isInOutOfStockUi(b)) {
        inModal = b;
        break;
      }
      exactEnabled = exactEnabled || b;
    }

    const found = inModal || exactEnabled || exactDisabled;
    if (found) {
      log('Found Save button:', describeNode(found), isInOutOfStockUi(found) ? '(in sub modal)' : '(fallback)');
    } else {
      const sample = candidates
        .map((b) => normalizeText(b.textContent || ''))
        .filter((t) => t.includes('save'))
        .slice(0, 8);
      log('No exact Save button. Labels containing "save":', sample);
    }
    return found;
  }

  function scrollContainerToBottom(fromEl) {
    let cur = fromEl;
    for (let i = 0; i < 14 && cur && cur !== document.body; i++) {
      try {
        if (cur.scrollHeight > cur.clientHeight + 24) {
          cur.scrollTop = cur.scrollHeight;
        }
      } catch (_) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
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
      const saveBtn = findVisibleSaveButton(roots) || findSaveButton(roots);
      if (
        saveBtn &&
        !saveBtn.disabled &&
        saveBtn.getAttribute('aria-disabled') !== 'true'
      ) {
        return saveBtn;
      }
      await wait(100);
    }
    return findVisibleSaveButton(roots) || findSaveButton(roots);
  }

  async function clickSaveRobustly(saveBtn) {
    if (!saveBtn) return false;
    const r = saveBtn.getBoundingClientRect();
    log('Save button (no scroll):', {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
    });
    simulateUserClick(saveBtn, { preventSubmit: false });
    try {
      saveBtn.click();
    } catch (_) {
      /* ignore */
    }
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
    if (aria.endsWith(' cart')) return true;
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
    if (el.nodeType !== 1) el = el.parentElement;
    if (!el) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      try {
        const s = window.getComputedStyle(cur);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (parseFloat(s.opacity) === 0) return false;
      } catch (_) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    try {
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2;
    } catch (_) {
      return true;
    }
  }

  /** Cart-row controls live in role=group; the out-of-stock modal usually does not. */
  function isInsideCartItem(el) {
    return !!(el && el.closest && el.closest('[role="group"][aria-label]'));
  }

  /**
   * True when `el` sits in the out-of-stock overlay, not merely in the cart
   * drawer that happens to contain a leftover "Refund this item" row.
   */
  function isInOutOfStockUi(el) {
    let cur = el;
    for (let i = 0; i < 16 && cur && cur !== document.body; i++) {
      if (isCartDrawerDialog(cur)) {
        cur = cur.parentElement;
        continue;
      }
      const t = normalizeText(cur.textContent);
      const hasTitle = SUB_MODAL_TITLE_PHRASES.some((p) => t.includes(p));
      if (
        hasTitle &&
        t.includes('replace with best match') &&
        t.length < 6000
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function hasOpenSubModal() {
    return !!findVisibleModalText(SUB_MODAL_TITLE_PHRASES, 40);
  }

  /**
   * Smallest *visible* element whose text matches a phrase, skipping cart-row
   * copies (e.g. an already-refunded item's "Refund this item" button).
   */
  function findVisibleModalText(phrases, maxLen) {
    const needles = (phrases || []).map(normalizeText).filter(Boolean);
    if (!needles.length) return null;

    let best = null;
    let bestScore = Infinity;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (isOurUi(el) || !isVisibleEl(el)) continue;
      const t = normalizeText(el.textContent);
      if (!t || t.length > (maxLen || 90)) continue;
      const hit = needles.find((n) => t === n || t.startsWith(n + ' ') || t.startsWith(n));
      if (!hit) continue;
      if (!isInOutOfStockUi(el) && isInsideCartItem(el)) continue;
      const score =
        t.length +
        (t === hit ? -80 : 0) +
        (isInOutOfStockUi(el) ? -200 : 0);
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  async function waitForVisibleModalText(phrases, timeoutMs, maxLen) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      const el = findVisibleModalText(phrases, maxLen);
      if (el) return el;
      await wait(120);
    }
    return findVisibleModalText(phrases, maxLen);
  }

  /**
   * Climb from a title (e.g. "Refund, don't replace") to its card, but STOP
   * before the parent also contains another option or Save. Clicking that
   * bigger node hits Best match / the green Save instead of refund.
   */
  function optionCardFromLabel(labelEl, forbiddenPhrases) {
    if (!labelEl) return null;
    const forbidden = (forbiddenPhrases || []).map(normalizeText).filter(Boolean);
    let best = labelEl;
    let cur = labelEl;
    while (cur.parentElement && cur.parentElement !== document.body) {
      const parent = cur.parentElement;
      const t = normalizeText(parent.textContent);
      if (forbidden.some((p) => t.includes(p))) break;
      if (/\bsave\b/.test(t) && t.includes('replace with best match')) break;
      if (t.length > 350) break;
      try {
        const r = parent.getBoundingClientRect();
        if (r.height > 260) break;
      } catch (_) {
        /* ignore */
      }
      best = parent;
      cur = parent;
    }
    return best;
  }

  /** Scroll the preference list only — never the cart drawer (that dismisses it). */
  function scrollOverflowParentToShow(el) {
    if (!el) return;
    let cur = el.parentElement;
    for (let i = 0; i < 16 && cur && cur !== document.body; i++) {
      if (isCartDrawerDialog(cur)) {
        cur = cur.parentElement;
        continue;
      }
      try {
        const st = window.getComputedStyle(cur);
        const oy = st.overflowY || st.overflow;
        if (
          (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          cur.scrollHeight > cur.clientHeight + 8
        ) {
          const t = normalizeText(cur.textContent);
          const inPreferenceUi =
            SUB_MODAL_TITLE_PHRASES.some((p) => t.includes(p)) ||
            t.includes("refund, don't replace") ||
            t.includes('refund this item');
          if (inPreferenceUi) {
            const elRect = el.getBoundingClientRect();
            const curRect = cur.getBoundingClientRect();
            cur.scrollTop += elRect.top - curRect.top - 16;
          }
        }
      } catch (_) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
  }

  function getPreferenceCards() {
    const best = findVisibleModalText(['replace with best match'], 100);
    const specific = findVisibleModalText(
      ['replace with specific item', 'specific item'],
      100
    );
    const refund = findVisibleModalText(REFUND_OPTION_PHRASES, 120);
    return {
      bestLabel: best,
      specificLabel: specific,
      refundLabel: refund,
      bestCard: optionCardFromLabel(best, [
        "refund, don't replace",
        'refund this item',
        'replace with specific item',
      ]),
      specificCard: optionCardFromLabel(specific, [
        'replace with best match',
        "refund, don't replace",
        'refund this item',
      ]),
      refundCard: optionCardFromLabel(refund, [
        'replace with best match',
        'replace with specific item',
      ]),
    };
  }

  function selectionScore(el) {
    if (!el) return 0;
    let score = 0;
    const inspect = (node, weight) => {
      if (!node) return;
      try {
        const st = window.getComputedStyle(node);
        score += (parseFloat(st.borderTopWidth) || 0) * weight;
        score += (parseFloat(st.outlineWidth) || 0) * weight;
        if (st.boxShadow && st.boxShadow !== 'none') score += 3 * weight;
        if (st.outlineStyle && st.outlineStyle !== 'none') score += 2 * weight;
      } catch (_) {
        /* ignore */
      }
    };
    inspect(el, 1);
    if (el.children) {
      for (const c of el.children) inspect(c, 0.5);
    }
    return score;
  }

  function refundCardIsSelected(cards) {
    if (!cards || !cards.refundCard || !cards.bestCard) return false;
    if (cards.refundCard === cards.bestCard) return false;
    const r = selectionScore(cards.refundCard);
    const b = selectionScore(cards.bestCard);
    log('Selection scores refund=', r, 'bestMatch=', b);
    return r > b + 1;
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
        SUB_MODAL_TITLE_PHRASES.some((p) => text.includes(p)) ||
        (DONT_REPLACE_PATTERNS.some((p) => text.includes(p)) &&
          text.includes('replace with best match'));
      if (!looksLikeSubModal) return;
      if (productName && !dialogMatchesProduct(d, productName)) return;
      push(d);
    });

    if (roots.length) return roots;

    // Portal / non-dialog overlay: find "Refund this item" text, walk up.
    // If productName is set, only accept containers that also mention it.
    const refundLabel = findLabelElement([document.body], REFUND_OPTION_PHRASES);
    if (refundLabel && refundLabel.el) {
      let cur = refundLabel.el;
      for (let i = 0; i < 15 && cur && cur !== document.body; i++) {
        const t = normalizeText(cur.textContent);
        if (
          REFUND_OPTION_PHRASES.some((p) => t.includes(p)) &&
          (SUB_MODAL_TITLE_PHRASES.some((p) => t.includes(p)) ||
            t.includes('replace with best match')) &&
          (t.includes('save') || t.includes('item will be refunded') || t.includes("don't replace"))
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
    const deadline = Date.now() + (timeoutMs || 4000);
    let any = [];
    while (Date.now() < deadline) {
      const matched = findSubDialogRoots(productName);
      if (matched.length) return matched;
      any = findSubDialogRoots(null);
      // Last 1.5s: accept the visible sub-modal even if product-name matching failed.
      if (any.length && Date.now() > deadline - 1500) return any;
      await wait(100);
    }
    return any;
  }

  /** Wait until leftover modals are gone (or timed out). */
  async function waitUntilNoSubDialog(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 1500);
    while (Date.now() < deadline) {
      if (!hasOpenSubModal()) return true;
      await wait(100);
    }
    return !hasOpenSubModal();
  }

  /**
   * Close only the replacement-preference overlay by its own X.
   * Never send Escape — Instacart treats Escape as "close the cart sidebar".
   */
  function dismissSubDialog() {
    const heading = findVisibleModalText(SUB_MODAL_TITLE_PHRASES, 40);
    if (!heading) {
      log('No replacement-preference heading — not dismissing via Escape (that closes the cart).');
      return false;
    }
    let root = heading;
    for (let i = 0; i < 14 && root && root !== document.body; i++) {
      const t = normalizeText(root.textContent);
      if (
        SUB_MODAL_TITLE_PHRASES.some((p) => t.includes(p)) &&
        t.includes('save') &&
        t.length < 6000
      ) {
        break;
      }
      root = root.parentElement;
    }
    if (!root || !root.querySelectorAll) return false;
    const buttons = root.querySelectorAll('button, [role="button"]');
    for (const el of buttons) {
      if (isOurUi(el)) continue;
      const aria = normalizeText(el.getAttribute('aria-label') || '');
      const textContent = normalizeText(el.textContent || '');
      if (aria === 'close' || aria === 'dismiss' || aria.startsWith('close ')) {
        log('Closing replacement modal via X:', describeNode(el));
        simulateUserClick(el);
        return true;
      }
      if (textContent === '×' || textContent === 'x') {
        log('Closing replacement modal via ×:', describeNode(el));
        simulateUserClick(el);
        return true;
      }
    }
    warn('Replacement modal open but no close control found — leaving it (will not Escape).');
    return false;
  }

  async function finishSubChange(item, detail, gen) {
    if (item && itemNoLongerBestMatch(item)) {
      removeBadge(item);
    }
    if (gen != null && gen !== interactionGen) {
      scheduleScan();
      return { ok: true, mode: 'native-option-saved', detail };
    }
    // Do not Escape. Save should close the preference modal; Escape closes the cart.
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
    const html = (row.outerHTML || '').toLowerCase();
    if (html.includes('aria-checked="true"') || html.includes(':checked')) return true;
    return false;
  }

  /** Instacart's selected card uses a thicker border more than native radios. */
  function optionCardLooksSelected(el) {
    if (!el) return false;
    if (optionRowLooksSelected(el)) return true;
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      const ariaSel = cur.getAttribute && cur.getAttribute('aria-selected');
      const ariaChecked = cur.getAttribute && cur.getAttribute('aria-checked');
      const dataState = (cur.getAttribute && cur.getAttribute('data-state')) || '';
      if (ariaSel === 'true' || ariaChecked === 'true') return true;
      if (String(dataState).toLowerCase().includes('selected')) return true;
      if (String(dataState).toLowerCase().includes('checked')) return true;
      try {
        const st = window.getComputedStyle(cur);
        const bw = parseFloat(st.borderTopWidth) || 0;
        if (bw >= 2 && st.borderTopStyle !== 'none' && st.borderTopStyle !== 'hidden') {
          return true;
        }
      } catch (_) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function bestMatchCardStillSelected() {
    const el = findVisibleModalText(['replace with best match'], 80);
    if (!el) return false;
    return optionCardLooksSelected(findClickableOptionRow(el) || el);
  }

  /**
   * Wait for option label, click it, retry until it looks selected.
   */
  async function selectDialogOption(searchRoots, preferredLabels) {
    let match = null;
    const roots = (searchRoots && searchRoots.length ? searchRoots : []).slice();
    if (!roots.includes(document.body)) roots.push(document.body);

    for (let i = 0; i < 30; i++) {
      match = findLabelElement(roots, preferredLabels);
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

    for (let attempt = 1; attempt <= 4; attempt++) {
      await clickVisible(match.el);
      if (row && row !== match.el) await clickVisible(row);
      const nestedRadio =
        (row &&
          row.querySelector &&
          row.querySelector('input[type="radio"], [role="radio"]')) ||
        null;
      if (nestedRadio && nestedRadio !== row) {
        await clickVisible(nestedRadio);
      }
      await wait(350);
      if (optionRowLooksSelected(row) || optionRowLooksSelected(nestedRadio)) {
        log('Option appears selected on attempt', attempt);
        return match;
      }
      log('Option not visibly selected yet — retry', attempt);
    }

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
  async function interactWithInstacartSub(item, intent, options) {
    const run = () => interactWithInstacartSubUnlocked(item, intent, options || {});
    const waitForTurn = interactionChain.then(run, run);
    interactionChain = waitForTurn.then(
      () => undefined,
      () => undefined
    );
    return waitForTurn;
  }

  async function interactWithInstacartSubUnlocked(item, intent, options) {
    const productName = productKey(item);
    const gen = ++interactionGen;
    const alreadyOpened = !!(options && options.alreadyOpened);

    if (intent === 'dont-replace' && itemAlreadyRefund(item)) {
      log('Cart row already shows refund — clearing badge / leftover modal.');
      hidePopoverForNativeUi();
      closePopover();
      return finishSubChange(item, 'Already set to refund — cleared extension badge.', gen);
    }

    const subButton = findCartRowSubControl(item) || findSubButton(item);
    if (!subButton && !alreadyOpened) {
      warn('No Instacart sub button found inside item — cannot drive native UI.');
      return {
        ok: false,
        mode: 'missing-button',
        detail: 'Could not find Instacart substitution button in this item.',
      };
    }

    hidePopoverForNativeUi();

    if (!alreadyOpened && subButton) {
      // Fallback only — the popover handler should have opened in the user-gesture turn.
      log('Opening Instacart substitution control after await (weaker):', productName);
      activateNativeSubControl(subButton);
    } else {
      log('Preference modal should already be opening for:', productName);
    }

    if (intent === 'dont-replace' || intent === 'specific' || intent === 'best-match') {
      const optionPhrasesForRow =
        intent === 'dont-replace'
          ? REFUND_OPTION_PHRASES
          : intent === 'best-match'
            ? BEST_MATCH_OPTION_PHRASES
            : ['replace with specific item', 'specific item'];

      const group = await waitForPreferenceRadiogroup(5000);
      if (!group) {
        warn('Visible modal option text not found for', intent, optionPhrasesForRow);
        return {
          ok: false,
          mode: 'option-not-found',
          detail:
            intent === 'dont-replace'
              ? 'Opened Instacart but could not see a visible refund option.'
              : intent === 'best-match'
                ? 'Opened Instacart but could not see “Replace with best match”.'
                : 'Opened Instacart but could not see a visible "Replace with specific item" option.',
        };
      }

      await wait(200);

      log('Preference radiogroup:', describeNode(group), 'children=', group.children.length);

      let optionStuck = false;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const liveGroup = findPreferenceRadiogroup() || group;
        const option = radiogroupOption(liveGroup, optionPhrasesForRow);
        if (!option) {
          log('No radiogroup option yet, attempt', attempt);
          await wait(200);
          continue;
        }
        const rowBase =
          (option.querySelector && option.querySelector('[data-testid="row-base"]')) ||
          option;
        log(
          'Clicking radiogroup option attempt',
          attempt,
          describeNode(option),
          'row-base=',
          describeNode(rowBase)
        );
        clickOptionNode(option);
        if (rowBase !== option) clickOptionNode(rowBase);
        if (clickPointFor(option)) simulateUserClick(option);
        await wait(400);
        optionStuck =
          intent === 'dont-replace'
            ? refundRadiogroupSelected(liveGroup)
            : intent === 'best-match'
              ? bestRadiogroupSelected(liveGroup)
              : true;
        log('Radiogroup selected=', optionStuck, 'intent=', intent);
        if (intent === 'specific') break;
        if (optionStuck) break;
      }

      if ((intent === 'dont-replace' || intent === 'best-match') && !optionStuck) {
        warn('Option never became selected — aborting Save.');
        return {
          ok: false,
          mode: 'option-not-selected',
          detail:
            intent === 'best-match'
              ? 'Could not select “Replace with best match”. Tap that row yourself, then Save.'
              : 'Could not select "Refund, don’t replace". Tap that card yourself, then Save.',
        };
      }

      if (intent === 'specific') {
        scheduleScan();
        return {
          ok: true,
          mode: 'native-option-saved',
          detail: 'Selected specific replacement — pick a product / Save in Instacart’s dialog.',
        };
      }

      const saveBtn =
        findVisibleSaveButton([group]) ||
        (await waitForEnabledSave([group], group, 3500));
      if (!saveBtn) {
        warn('No visible Save button after option selected.');
        return {
          ok: false,
          mode: 'save-not-found',
          detail: 'Option is selected — tap Instacart’s green Save.',
        };
      }

      const liveGroup = findPreferenceRadiogroup() || group;
      const stillSelected =
        intent === 'best-match'
          ? bestRadiogroupSelected(liveGroup)
          : refundRadiogroupSelected(liveGroup);
      if (!stillSelected) {
        warn('Selection lost just before Save — aborting.');
        return {
          ok: false,
          mode: 'option-not-selected',
          detail: 'Selection did not stay. Tap the Instacart option, then Save.',
        };
      }

      log('Option selected. Clicking Save ONCE for:', productName, intent);
      await clickSaveRobustly(saveBtn);

      for (let i = 0; i < 20; i++) {
        if (intent === 'best-match') {
          if (findSubButton(item)) {
            log('Cart row confirmed best match after Save');
            return finishSubChange(
              item,
              'Selected best match and saved.',
              gen
            );
          }
        } else if (itemNoLongerBestMatch(item)) {
          log('Cart row confirmed refund/non-best-match after Save');
          return finishSubChange(
            item,
            'Selected refund and saved — cart no longer on best match.',
            gen
          );
        }
        await wait(150);
      }

      if (intent === 'best-match' && findSubButton(item)) {
        return finishSubChange(item, 'Selected best match and saved.', gen);
      }
      if (intent !== 'best-match' && itemNoLongerBestMatch(item)) {
        return finishSubChange(
          item,
          'Selected refund and saved — cart no longer on best match.',
          gen
        );
      }

      warn('Saved but cart row did not update as expected.');
      return {
        ok: false,
        mode: 'save-unconfirmed',
        detail:
          'Save was clicked. If the cart row is wrong, set it once in Instacart’s menu.',
      };
    }

    let dialogs = await waitForSubDialog(4000, productName);
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
        ? REFUND_OPTION_PHRASES.concat(DONT_REPLACE_PATTERNS)
        : ['replace with specific item', ...SPECIFIC_REPLACEMENT_PATTERNS];

    const match = await selectDialogOption(searchRoots, preferredLabels);
    if (!match) {
      warn('Could not find/select option for', intent, preferredLabels);
      return {
        ok: false,
        mode: 'option-not-found',
        detail:
          intent === 'dont-replace'
            ? 'Dialog opened but could not select the refund option.'
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
    const saveBtn = await waitForEnabledSave(searchRoots, match.el, 3000);
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
        return finishSubChange(
          item,
          `Selected "${match.text}" and saved — cart no longer on best match.`,
          gen
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
        const again =
          (await waitForEnabledSave(searchRoots, match.el, 500)) ||
          findVisibleSaveButton(searchRoots);
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

  function bindBadgeOpen(badge) {
    if (!badge || badge.dataset.subSpotlightBound === '1') return;
    badge.dataset.subSpotlightBound = '1';
    badge.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const item = findItemForBadge(badge);
        if (item) openPopover(item, badge);
      },
      true
    );
    badge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = findItemForBadge(badge);
      if (item) openPopover(item, badge);
    });
  }

  function findItemForBadge(el) {
    if (!el) return null;
    const fromClosest = el.closest('[role="group"][aria-label]');
    if (fromClosest) return fromClosest;
    const name = el.getAttribute('data-sub-spotlight-product') || '';
    if (!name) return null;
    const items = document.querySelectorAll('[role="group"][aria-label]');
    for (const it of items) {
      if (productKey(it) === name) return it;
    }
    return null;
  }

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
    bindBadgeOpen(badge);

    badge.dataset.subSpotlightProduct = productName || '';
    badge.textContent = '⚠ Auto-substitute: best match ▾';
    badge.classList.remove('sub-spotlight-badge-refund', 'sub-spotlight-badge-specific');
    badge.title =
      (productName || 'This item') +
      ' will be auto-replaced if out of stock. Click to change setting or add a note.';
    item.setAttribute(PROCESSED_ATTR, 'true');
  }

  function ensureRefundBadge(item, productName) {
    let badge = item.querySelector(':scope > .' + BADGE_CLASS);
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = BADGE_CLASS;
      badge.setAttribute('data-sub-spotlight-action', 'open-popover');
      item.prepend(badge);
    }
    bindBadgeOpen(badge);
    badge.dataset.subSpotlightProduct = productName || '';
    badge.classList.add('sub-spotlight-badge-refund');
    badge.classList.remove('sub-spotlight-badge-specific');
    badge.textContent = 'Refund if out of stock ▾';
    badge.title =
      (productName || 'This item') +
      ' will be refunded if out of stock. Click to switch back to best match.';
    item.setAttribute(PROCESSED_ATTR, 'refund');
  }

  function ensureSpecificBadge(item, productName) {
    let badge = item.querySelector(':scope > .' + BADGE_CLASS);
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = BADGE_CLASS;
      badge.setAttribute('data-sub-spotlight-action', 'open-popover');
      item.prepend(badge);
    }
    bindBadgeOpen(badge);
    badge.dataset.subSpotlightProduct = productName || '';
    badge.classList.add('sub-spotlight-badge-specific');
    badge.classList.remove('sub-spotlight-badge-refund');
    badge.textContent = 'Specific replacement ▾';
    badge.title =
      (productName || 'This item') +
      ' has a specific backup selected. Click to change setting or add a note.';
    item.setAttribute(PROCESSED_ATTR, 'specific');
  }

  function removeBadge(item) {
    const badge = item.querySelector(':scope > .' + BADGE_CLASS);
    if (badge) badge.remove();
    item.removeAttribute(PROCESSED_ATTR);
    removeGuide(item);
  }

  function clearNativeHighlight() {
    document.querySelectorAll('.' + PULSE_CLASS).forEach((el) => {
      el.classList.remove(PULSE_CLASS);
    });
  }

  function removeGuide(item) {
    if (!item) {
      document.querySelectorAll('.' + GUIDE_CLASS).forEach((el) => el.remove());
      clearNativeHighlight();
      return;
    }
    const g = item.querySelector(':scope > .' + GUIDE_CLASS);
    if (g) g.remove();
    const btn = findSubButton(item);
    if (btn) btn.classList.remove(PULSE_CLASS);
  }

  /**
   * Do not script-click Instacart. Chrome marks those events untrusted;
   * on the new cart drawer that submits/dismisses the sidebar instead of
   * opening Replacement preference. Point at the real control instead.
   */
  function guideToNativePreference(item, kind) {
    closePopover();
    if (!item) return;
    const nativeBtn = findSubButton(item);
    if (nativeBtn) nativeBtn.classList.add(PULSE_CLASS);

    let guide = item.querySelector(':scope > .' + GUIDE_CLASS);
    if (!guide) {
      guide = document.createElement('div');
      guide.className = GUIDE_CLASS;
      const badge = item.querySelector(':scope > .' + BADGE_CLASS);
      if (badge) badge.after(guide);
      else item.prepend(guide);
    }
    guide.textContent =
      kind === 'specific'
        ? 'Tap the highlighted substitution control, choose “Replace with specific item”, pick a product, then Save. The yellow badge clears when Instacart updates.'
        : 'Tap the highlighted substitution control, choose “Refund, don’t replace”, then Save. The yellow badge clears when Instacart updates.';
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
      const autoBadge = item.querySelector(':scope > .' + BADGE_CLASS);
      if (autoBadge && autoBadge.nextSibling) {
        item.insertBefore(noteBadge, autoBadge.nextSibling);
      } else if (autoBadge) {
        autoBadge.after(noteBadge);
      } else {
        item.prepend(noteBadge);
      }
    }

    noteBadge.dataset.subSpotlightProduct = productName || '';
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
    bindBadgeOpen(noteBadge);
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
    if (!panel.classList.contains('sub-spotlight-collapsed')) {
      const legend = document.createElement('div');
      legend.className = 'sub-spotlight-legend';
      legend.appendChild(legendChip('best', 'Best match'));
      legend.appendChild(legendChip('refund', 'Refund'));
      legend.appendChild(legendChip('specific', 'Specific'));
      panel.appendChild(legend);
    }
  }

  function legendChip(kind, label) {
    const wrap = document.createElement('span');
    wrap.className = 'sub-spotlight-legend-chip';
    const box = document.createElement('span');
    box.className = 'sub-spotlight-legend-box sub-spotlight-legend-box-' + kind;
    wrap.appendChild(box);
    wrap.appendChild(document.createTextNode(' ' + label));
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Custom popover UI (ours — not Instacart's)
  // ---------------------------------------------------------------------------

  let popoverOpenedAt = 0;

  function closePopover() {
    const existing = document.getElementById(POPOVER_ID);
    if (existing) existing.remove();
    activePopoverItem = null;
    activePopoverProduct = '';
  }

  function hostForPopover(item) {
    if (item && item.closest) {
      const fromItem = item.closest('[role="dialog"]');
      if (fromItem && isCartDrawerDialog(fromItem)) return fromItem;
    }
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      if (isCartDrawerDialog(d)) return d;
    }
    return item;
  }

  function placePopoverNearAnchor(popover, anchorEl) {
    const host = popover.parentElement;
    const rect =
      anchorEl && anchorEl.getBoundingClientRect
        ? anchorEl.getBoundingClientRect()
        : { bottom: 80, left: 16, top: 80, width: 200 };
    const hostRect = host && host.getBoundingClientRect
      ? host.getBoundingClientRect()
      : { top: 0, left: 0 };
    const pad = 8;
    const width = Math.min(320, window.innerWidth - pad * 2);
    // Cart drawers often use transform, which turns position:fixed into
    // "absolute vs the drawer" while we were feeding viewport coords —
    // the menu rendered off-screen. Use host-relative absolute instead.
    let top = Math.round(rect.bottom - hostRect.top + 6);
    let left = Math.round(rect.left - hostRect.left);
    if (left + width > hostRect.width - pad && hostRect.width > 0) {
      left = Math.max(pad, hostRect.width - width - pad);
    }
    if (left < pad) left = pad;
    const hostPos = host ? window.getComputedStyle(host).position : 'static';
    const contained = host && hostPos !== 'static';
    if (contained) {
      popover.style.position = 'absolute';
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
    } else {
      popover.style.position = 'fixed';
      popover.style.left = Math.round(rect.left) + 'px';
      popover.style.top = Math.round(rect.bottom + 6) + 'px';
    }
    popover.style.zIndex = '2147483646';
    popover.style.width = width + 'px';
    const popH = popover.offsetHeight || 280;
    if (contained) {
      const hostH = hostRect.height || window.innerHeight;
      if (top + popH > hostH - pad) {
        const above = Math.round(rect.top - hostRect.top - popH - 6);
        popover.style.top = Math.max(pad, above) + 'px';
      }
    } else if (rect.bottom + 6 + popH > window.innerHeight - pad) {
      popover.style.top = Math.max(pad, Math.round(rect.top - popH - 6)) + 'px';
    }
  }

  function resolveActiveItem() {
    if (activePopoverItem && activePopoverItem.isConnected) return activePopoverItem;
    if (!activePopoverProduct) return null;
    const items = document.querySelectorAll('[role="group"][aria-label]');
    for (const it of items) {
      if (productKey(it) === activePopoverProduct) return it;
    }
    return null;
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
    activePopoverItem = item;
    activePopoverProduct = productName;

    const popover = document.createElement('div');
    popover.id = POPOVER_ID;
    popover.setAttribute('role', 'menu');
    popover.setAttribute('aria-label', 'Change substitution setting');

    const heading = document.createElement('div');
    heading.className = 'sub-spotlight-popover-heading';
    heading.textContent = productName || 'Substitution options';
    popover.appendChild(heading);

    // --- Option 1: keep best match ---
    const btnBest = document.createElement('button');
    btnBest.type = 'button';
    btnBest.className = 'sub-spotlight-popover-option';
    btnBest.setAttribute('data-sub-spotlight-action', 'keep-best');
    btnBest.textContent = itemAlreadyRefund(item)
      ? 'Replace with best match / similar item'
      : 'Best match (current)';
    btnBest.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!itemAlreadyRefund(item) && findSubButton(item)) {
        closePopover();
        return;
      }
      btnBest.disabled = true;
      const liveItem = resolveActiveItem() || item;
      const subButton = findCartRowSubControl(liveItem);
      setPopoverStatus(popover, 'Switching Instacart back to best match…', 'info');
      if (subButton) activateNativeSubControl(subButton);
      void (async () => {
        for (let i = 0; i < 25; i++) {
          if (preferenceModalOpen()) break;
          await wait(80);
        }
        if (preferenceModalOpen()) hidePopoverForNativeUi();
        const result = await interactWithInstacartSub(liveItem, 'best-match', {
          alreadyOpened: true,
        });
        if (result.ok) {
          closePopover();
          log('Native best-match preference applied:', result.detail);
        } else {
          showPopoverAgain(popover);
          setPopoverStatus(popover, result.detail, 'error');
          btnBest.disabled = false;
        }
      })();
    });
    popover.appendChild(btnBest);

    // --- Option 2: don't replace (native) ---
    const btnDont = document.createElement('button');
    btnDont.type = 'button';
    btnDont.className = 'sub-spotlight-popover-option';
    btnDont.setAttribute('data-sub-spotlight-action', 'dont-replace');
    btnDont.textContent = "Don't replace — refund me instead";
    btnDont.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btnDont.disabled = true;
      const liveItem = resolveActiveItem() || item;
      const subButton = findCartRowSubControl(liveItem);
      setPopoverStatus(popover, 'Opening Instacart’s replacement preference…', 'info');
      // Same turn as the user's click — do not await before this.
      if (subButton) activateNativeSubControl(subButton);
      void (async () => {
        for (let i = 0; i < 25; i++) {
          if (preferenceModalOpen()) break;
          await wait(80);
        }
        if (preferenceModalOpen()) hidePopoverForNativeUi();
        const result = await interactWithInstacartSub(liveItem, 'dont-replace', {
          alreadyOpened: true,
        });
        if (result.ok) {
          closePopover();
          removeGuide(liveItem);
          log('Native refund preference applied:', result.detail);
        } else {
          showPopoverAgain(popover);
          setPopoverStatus(popover, result.detail, 'error');
          btnDont.disabled = false;
        }
      })();
    });
    popover.appendChild(btnDont);

    // --- Option 3: specific backup ---
    const specificWrap = document.createElement('div');
    specificWrap.className = 'sub-spotlight-popover-specific';

    const btnSpecific = document.createElement('button');
    btnSpecific.type = 'button';
    btnSpecific.className = 'sub-spotlight-popover-option';
    btnSpecific.setAttribute('data-sub-spotlight-action', 'specific');
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
    btnSaveNote.setAttribute('data-sub-spotlight-action', 'save-note');
    btnSaveNote.textContent = 'Save personal note';
    btnSaveNote.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
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
    btnClearNote.setAttribute('data-sub-spotlight-action', 'clear-note');
    btnClearNote.textContent = 'Clear note';
    btnClearNote.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      noteInput.value = '';
      await saveNote(productName, '');
      setPopoverStatus(popover, 'Cleared local note.', 'ok');
      await wait(500);
      closePopover();
    });
    noteActions.appendChild(btnClearNote);
    specificWrap.appendChild(noteActions);

    btnSpecific.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btnSpecific.disabled = true;
      const liveItem = resolveActiveItem() || item;
      const subButton = findCartRowSubControl(liveItem);
      hidePopoverForNativeUi();
      if (subButton) activateNativeSubControl(subButton);
      setPopoverStatus(
        popover,
        'Opening Instacart’s specific-replacement control…',
        'info'
      );
      void (async () => {
        const result = await interactWithInstacartSub(liveItem, 'specific', {
          alreadyOpened: true,
        });
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
              ' Use the text field below as a personal reminder if the picker did not open.',
            'error'
          );
          noteInput.focus();
        }
        btnSpecific.disabled = false;
      })();
    });

    popover.appendChild(specificWrap);

    // Inside the cart drawer (not the page) so Instacart does not treat the
    // click as "outside the cart". position:fixed so the item row cannot clip it.
    const host = hostForPopover(item);
    host.appendChild(popover);
    placePopoverNearAnchor(popover, anchorEl);
    popoverOpenedAt = Date.now();
    log('Opened extension popover for:', productName);
  }

  // ---------------------------------------------------------------------------
  // Scan (MutationObserver-driven)
  // ---------------------------------------------------------------------------

  function findCartDrawer() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      if (isCartDrawerDialog(d)) return d;
    }
    return null;
  }

  function collectCartItems() {
    const drawer = findCartDrawer();
    const root = drawer || document;
    const items = [...root.querySelectorAll('[role="group"][aria-label]')];
    return items.filter((item) => {
      if (isNestedReplacementGroup(item)) return false;
      if (drawer && !drawer.contains(item)) return false;
      return looksLikeCartLine(item);
    });
  }

  function removeOrphanBadges(keepItems) {
    const keep = new Set(keepItems);
    document
      .querySelectorAll('.' + BADGE_CLASS + ', .' + NOTE_BADGE_CLASS + ', .' + GUIDE_CLASS)
      .forEach((el) => {
        const item = el.closest('[role="group"][aria-label]');
        if (!item || !keep.has(item)) el.remove();
      });
  }

  function scan() {
    // Do not inject/remove badges while Instacart's replacement modal is
    // open — that DOM mutation fights React and blocks switching back to
    // best match from Instacart's own UI (Tide, Heinz, etc.).
    if (preferenceModalOpen()) {
      return;
    }

    const items = collectCartItems();
    removeOrphanBadges(items);
    let flaggedCount = 0;

    items.forEach((item) => {
      const productName = productKey(item);
      const kind = classifyCartItem(item);

      if (kind === 'refund') {
        ensureRefundBadge(item, productName);
      } else if (kind === 'specific') {
        ensureSpecificBadge(item, productName);
      } else if (kind === 'best') {
        ensureBadge(item, productName);
        flaggedCount++;
      } else {
        removeBadge(item);
      }

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

  function isOurUiTarget(target) {
    return !!(
      target instanceof Element &&
      target.closest &&
      target.closest(
        '#' +
          POPOVER_ID +
          ', #' +
          PANEL_ID +
          ', .' +
          BADGE_CLASS +
          ', .' +
          NOTE_BADGE_CLASS +
          ', .' +
          GUIDE_CLASS
      )
    );
  }

  /**
   * Cart rows often put an invisible overlay on top of our badges, so
   * event.target is Instacart's node even though the box is what you
   * clicked. Hit-test the stack and open on pointerdown.
   */
  function ourUiFromPoint(x, y) {
    let stack = [];
    try {
      stack = document.elementsFromPoint(x, y) || [];
    } catch (_) {
      return null;
    }
    for (const el of stack) {
      if (!(el instanceof Element)) continue;
      const hit = el.closest(
        '.' +
          BADGE_CLASS +
          ', .' +
          NOTE_BADGE_CLASS +
          ', #' +
          POPOVER_ID +
          ', #' +
          PANEL_ID
      );
      if (hit) return hit;
    }
    return null;
  }

  function shieldPointerFromInstacart(event) {
    if (ignoreProgrammaticInput) return;
    if (event.button != null && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[role="radiogroup"], [data-testid="row-base"]')) return;

    const hit =
      ourUiFromPoint(event.clientX, event.clientY) ||
      target.closest(
        '.' +
          BADGE_CLASS +
          ', .' +
          NOTE_BADGE_CLASS +
          ', #' +
          POPOVER_ID +
          ', #' +
          PANEL_ID
      );
    if (!hit) return;

    // Let popover option buttons receive the real event.
    if (hit.id === POPOVER_ID || (hit.closest && hit.closest('#' + POPOVER_ID))) {
      return;
    }

    if (hit.id === PANEL_ID) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    const badge = hit.closest
      ? hit.closest(
          '.' + BADGE_CLASS + ', .' + NOTE_BADGE_CLASS + ', [data-sub-spotlight-action="open-popover"]'
        )
      : hit;
    if (!badge) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const item = findItemForBadge(badge);
    if (item) openPopover(item, badge);
  }

  ['pointerdown'].forEach((type) => {
    window.addEventListener(type, shieldPointerFromInstacart, {
      capture: true,
      passive: false,
    });
  });

  document.addEventListener(
    'click',
    (event) => {
      if (ignoreProgrammaticInput) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('#' + POPOVER_ID)) {
        return;
      }

      // Instacart's preference rows — do not close our menu in the same
      // turn (removing DOM from the cart item resets their radiogroup).
      if (target.closest('[role="radiogroup"], [data-testid="row-base"]')) {
        if (document.getElementById(POPOVER_ID) && Date.now() - popoverOpenedAt > 400) {
          closePopover();
        }
        return;
      }

      if (target.closest('#' + PANEL_ID)) {
        if (target.closest('.sub-spotlight-legend')) return;
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
          panel.classList.toggle('sub-spotlight-collapsed');
          applyPanelText(panel, Number(panel.dataset.count || 0));
        }
        return;
      }

      const actionEl = target.closest('[data-sub-spotlight-action="open-popover"]');
      if (actionEl) {
        event.preventDefault();
        event.stopPropagation();
        const item = findItemForBadge(actionEl);
        if (item) {
          openPopover(item, actionEl);
        }
        return;
      }

      if (document.getElementById(POPOVER_ID) && Date.now() - popoverOpenedAt > 400) {
        closePopover();
      }
    },
    true
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (ignoreProgrammaticInput) return;
      if (event.key !== 'Escape') return;
      if (!document.getElementById(POPOVER_ID)) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.preventDefault();
      closePopover();
    },
    true
  );

  // Instacart's cart is a single-page app — content loads/re-renders
  // dynamically, so we watch for DOM changes instead of scanning once.
  // Ignore mutations we ourselves cause inside the popover / panel to
  // reduce scan thrash (still debounced either way).
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const t = m.target;
      if (!(t instanceof Element)) return true;
      if (t.closest('#' + POPOVER_ID + ', #' + PANEL_ID + ', .' + GUIDE_CLASS)) return false;
      if (
        t.classList &&
        (t.classList.contains(BADGE_CLASS) ||
          t.classList.contains(NOTE_BADGE_CLASS) ||
          t.classList.contains(GUIDE_CLASS) ||
          t.classList.contains(PULSE_CLASS))
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
      'Don\'t replace opens Instacart in the same click, then selects refund and Save.'
    );
    scheduleScan();
  });
})();
