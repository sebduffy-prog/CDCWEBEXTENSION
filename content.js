/* ================================================================
   Chef de Commis v6.0 — Content Script
   ================================================================
   Architecture:
   1. Event Shield Selection Engine   — mousedown capture-phase interception
   2. Container-Based Extraction Math — LCA-aligned row extraction
   3. Auto-Scroll & Pagination        — append + deduplicate pipeline
   ================================================================ */

(() => {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────
  const HOVER_STYLE_ID   = 'chef-de-commis-style';
  const TOAST_ID         = 'chef-toast';
  const SHIELD_DURATION  = 500;   // ms to keep post-selection shield active
  const SCROLL_SETTLE_MS = 1200;  // ms to wait after each scroll tick
  const LAZY_RENDER_MS   = 600;   // ms to wait for lazy-loaded content
  const PAGE_SETTLE_MS   = 2500;  // ms to wait after page navigation

  // Transient classes/attributes to strip from selectors
  const TRANSIENT_CLASS_RE = /hover|active|focus|selected|open|visible|show|chef-hover|style-scope/i;

  // ─── Selection State ───────────────────────────────────────
  let selectionTarget = null;     // column name or 'next_btn'

  // References to shield listeners so we can remove them precisely
  let shieldClick   = null;
  let shieldMouseUp = null;
  let shieldTimer   = null;

  // ─── Hover Style Injection ─────────────────────────────────
  function injectHoverStyle() {
    if (document.getElementById(HOVER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HOVER_STYLE_ID;
    style.textContent = `
      .chef-hover {
        outline: 3px solid #f7d74a !important;
        outline-offset: -1px !important;
        cursor: crosshair !important;
        background-color: rgba(247, 215, 74, 0.12) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeHoverStyle() {
    const style = document.getElementById(HOVER_STYLE_ID);
    if (style) style.remove();
    document.querySelectorAll('.chef-hover').forEach(el => el.classList.remove('chef-hover'));
  }

  // ─── Hover Handlers ────────────────────────────────────────
  function onHoverIn(e) {
    if (e.target && e.target.nodeType === Node.ELEMENT_NODE) {
      e.target.classList.add('chef-hover');
    }
  }

  function onHoverOut(e) {
    if (e.target && e.target.nodeType === Node.ELEMENT_NODE) {
      e.target.classList.remove('chef-hover');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  1. THE EVENT SHIELD SELECTION ENGINE
  // ═══════════════════════════════════════════════════════════

  function startSelectionMode(columnOrAction) {
    selectionTarget = columnOrAction;

    injectHoverStyle();

    // Hover feedback — capture phase so we see it before the page
    document.addEventListener('mouseover', onHoverIn,  { capture: true });
    document.addEventListener('mouseout',  onHoverOut, { capture: true });

    // The selection trigger: mousedown on capture phase
    document.addEventListener('mousedown', onSelectionMouseDown, { capture: true });
  }

  async function onSelectionMouseDown(e) {
    // ── Step 1 & 2: Capture target, kill the event completely ──
    const target = e.target;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // ── Step 5: Remove selection listeners immediately ──
    document.removeEventListener('mouseover', onHoverIn,  { capture: true });
    document.removeEventListener('mouseout',  onHoverOut, { capture: true });
    document.removeEventListener('mousedown', onSelectionMouseDown, { capture: true });

    // Remove hover highlight
    if (target) target.classList.remove('chef-hover');
    removeHoverStyle();

    // ── Step 3: Compute a highly specific CSS selector ──
    const selector = computeSelector(target);

    // ── Step 4: Persist to chrome.storage.local ──
    if (selectionTarget === 'next_btn') {
      await chrome.storage.local.set({ chef_next_btn: selector });
      showToast('Next-page button saved');
    } else {
      const { chef_columns = [] } = await chrome.storage.local.get('chef_columns');
      const col = chef_columns.find(c => c.name === selectionTarget);
      if (col) {
        col.selector = selector;
      } else {
        chef_columns.push({ name: selectionTarget, selector });
      }
      await chrome.storage.local.set({ chef_columns });

      // Run an immediate extraction so the popup can show counts
      await extractAndStore('overwrite');
      showToast(`Mapped: ${selectionTarget}`);
    }

    selectionTarget = null;

    // ── Step 6: The Shield ──
    // Attach capture-phase blockers for mouseup and click so the page
    // never sees the tail end of this pointer interaction.
    installShield();
  }

  function installShield() {
    // Clear any prior shield
    clearShield();

    shieldClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    shieldMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    document.addEventListener('click',   shieldClick,   { capture: true });
    document.addEventListener('mouseup', shieldMouseUp, { capture: true });

    shieldTimer = setTimeout(clearShield, SHIELD_DURATION);
  }

  function clearShield() {
    if (shieldClick)   document.removeEventListener('click',   shieldClick,   { capture: true });
    if (shieldMouseUp) document.removeEventListener('mouseup', shieldMouseUp, { capture: true });
    if (shieldTimer)   clearTimeout(shieldTimer);
    shieldClick = null;
    shieldMouseUp = null;
    shieldTimer = null;
  }

  // ─── CSS Selector Computation ──────────────────────────────
  // Priority: id → tag + stable classes → nth-child tree
  function computeSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // Strategy 1: Element has an id — return it directly
    if (el.id && !TRANSIENT_CLASS_RE.test(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (isUnique(sel)) return sel;
    }

    // Strategy 2: Build tag.class selector, walk up until unique (max 5 levels)
    const parts = [];
    let cur = el;
    for (let depth = 0; depth < 5 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
      const segment = buildSegment(cur);
      parts.unshift(segment);

      const candidate = parts.join(' > ');
      // If an ancestor has an id, anchor there
      if (cur.id && !TRANSIENT_CLASS_RE.test(cur.id)) {
        const anchored = `#${CSS.escape(cur.id)} > ${parts.slice(1).join(' > ')}`;
        if (document.querySelector(anchored)) return anchored;
      }
      // Check uniqueness — but we want the selector to also match siblings,
      // so for the FIRST segment only, skip uniqueness (we need querySelectorAll
      // to return all similar elements)
      if (depth >= 1 && isUnique(candidate)) return candidate;

      cur = cur.parentElement;
    }

    // Strategy 3: nth-child absolute path (most specific, always unique)
    return buildNthChildPath(el);
  }

  function buildSegment(el) {
    const tag = el.tagName.toLowerCase();
    const stableClasses = getStableClasses(el);
    if (stableClasses.length > 0) {
      return `${tag}.${stableClasses.map(CSS.escape).join('.')}`;
    }
    return tag;
  }

  function getStableClasses(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className
      .split(/\s+/)
      .filter(c => c && !TRANSIENT_CLASS_RE.test(c));
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch { return false; }
  }

  function buildNthChildPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }

      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-child(${idx})`);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ═══════════════════════════════════════════════════════════
  //  2. CONTAINER-BASED EXTRACTION MATH
  // ═══════════════════════════════════════════════════════════

  // --- Lowest Common Ancestor ---
  // Given N elements, find their closest shared parent in the DOM.
  function findLCA(elements) {
    if (elements.length === 0) return null;
    if (elements.length === 1) return elements[0].parentElement;

    // Build ancestor chain for the first element
    function ancestors(el) {
      const chain = [];
      let cur = el;
      while (cur) { chain.push(cur); cur = cur.parentElement; }
      return chain;
    }

    let common = ancestors(elements[0]);
    for (let i = 1; i < elements.length; i++) {
      const set = new Set(ancestors(elements[i]));
      common = common.filter(node => set.has(node));
    }
    // `common` is now ordered from deepest to shallowest shared ancestor.
    // The first entry is the LCA.
    return common.length > 0 ? common[0] : document.body;
  }

  // Find the repeating container element (the "row wrapper").
  // Walk up from the LCA looking for an element that, when queried by
  // tag+classes, returns multiple siblings — these are our containers.
  function findContainerSelector(activeCols) {
    // Get one representative element per column
    const representatives = [];
    for (const col of activeCols) {
      const el = safeQuerySelector(col.selector);
      if (!el) return null;
      representatives.push(el);
    }

    const lca = findLCA(representatives);
    if (!lca || lca === document.body || lca === document.documentElement) return null;

    // The LCA itself is the shared parent of *one* set of column elements.
    // The repeating container is the LCA or its children pattern.
    // Walk up from LCA: find the first ancestor whose parent has multiple
    // children matching the same tag+class signature.
    let candidate = lca;
    for (let depth = 0; depth < 8; depth++) {
      const sel = buildReusableSelector(candidate);
      if (sel) {
        const matches = document.querySelectorAll(sel);
        if (matches.length >= 2) {
          // Verify: each container should contain at least one column element
          const valid = Array.from(matches).filter(container =>
            activeCols.some(col => queryInsideContainer(container, col.selector))
          );
          if (valid.length >= 2) return sel;
        }
      }
      if (!candidate.parentElement || candidate.parentElement === document.body) break;
      candidate = candidate.parentElement;
    }
    return null;
  }

  // Build a reusable selector for a container element (tag + stable classes).
  function buildReusableSelector(el) {
    if (!el || el === document.body) return null;
    const tag = el.tagName.toLowerCase();
    const classes = getStableClasses(el);
    if (classes.length > 0) {
      return `${tag}.${classes.map(CSS.escape).join('.')}`;
    }
    // If no classes, try parent > tag
    const parent = el.parentElement;
    if (parent && parent !== document.body) {
      const pClasses = getStableClasses(parent);
      const pTag = parent.tagName.toLowerCase();
      if (pClasses.length > 0) {
        return `${pTag}.${pClasses.map(CSS.escape).join('.')} > ${tag}`;
      }
    }
    return null;
  }

  // Query for a column's element inside a specific container.
  // Tries the full selector, progressively shorter suffixes, and fuzzy class match.
  function queryInsideContainer(container, fullSelector) {
    if (!fullSelector) return null;

    // Direct attempt
    try {
      let el = container.querySelector(fullSelector);
      if (el) return el;
    } catch { /* invalid selector for this context */ }

    // Strip leading segments (the selector may include the container itself)
    const childCombinatorParts = fullSelector.split(/\s*>\s*/);
    for (let i = 1; i < childCombinatorParts.length; i++) {
      try {
        const sub = childCombinatorParts.slice(i).join(' > ');
        const el = container.querySelector(sub);
        if (el) return el;
      } catch { /* continue */ }
    }

    // Descendant combinator splits
    const spaceParts = fullSelector.split(/\s+/);
    for (let i = 1; i < spaceParts.length; i++) {
      try {
        const sub = spaceParts.slice(i).join(' ');
        const el = container.querySelector(sub);
        if (el) return el;
      } catch { /* continue */ }
    }

    // Last-resort: match by the terminal class
    const classMatch = fullSelector.match(/\.([a-zA-Z0-9_-]+)(?:\s|>|$)/g);
    if (classMatch) {
      const lastClass = classMatch[classMatch.length - 1].replace(/[.>\s]/g, '');
      if (lastClass) {
        try {
          const el = container.querySelector(`.${CSS.escape(lastClass)}`);
          if (el) return el;
        } catch { /* give up */ }
      }
    }

    return null;
  }

  function safeQuerySelector(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }

  function safeQuerySelectorAll(sel) {
    try { return Array.from(document.querySelectorAll(sel)); } catch { return []; }
  }

  // ─── Core Extraction ───────────────────────────────────────
  // Returns an Array of Objects: [{ colName: value, ... }, ...]
  function extractRows(columns) {
    const activeCols = columns.filter(c => c.selector);
    if (activeCols.length === 0) return [];

    // --- Container-Based path (2+ columns) ---
    if (activeCols.length >= 2) {
      const containerSel = findContainerSelector(activeCols);
      if (containerSel) {
        const containers = safeQuerySelectorAll(containerSel);
        const rows = [];
        for (const container of containers) {
          const row = {};
          for (const col of columns) {
            if (!col.selector) { row[col.name] = 'N/A'; continue; }
            const el = queryInsideContainer(container, col.selector);
            const text = el ? el.innerText.trim() : '';
            row[col.name] = text || 'N/A';
          }
          rows.push(row);
        }
        if (rows.length > 0) return rows;
        // Fall through to independent extraction if container approach yields nothing
      }
    }

    // --- Independent Extraction fallback (single column or no LCA found) ---
    const columnArrays = {};
    let maxLen = 0;
    for (const col of activeCols) {
      let els = safeQuerySelectorAll(col.selector);

      // Fuzzy class fallback
      if (els.length === 0) {
        const classes = col.selector.match(/\.([a-zA-Z0-9_-]+)/g);
        if (classes && classes.length > 0) {
          const lastClass = classes[classes.length - 1].replace('.', '');
          els = safeQuerySelectorAll(`[class*="${lastClass}"]`);
        }
      }

      columnArrays[col.name] = els.map(el => {
        const text = el.innerText.trim();
        return text || 'N/A';
      });
      maxLen = Math.max(maxLen, columnArrays[col.name].length);
    }

    const rows = [];
    for (let i = 0; i < maxLen; i++) {
      const row = {};
      for (const col of columns) {
        row[col.name] = (columnArrays[col.name] && columnArrays[col.name][i]) || 'N/A';
      }
      rows.push(row);
    }
    return rows;
  }

  // ─── Extract & Store Pipeline ──────────────────────────────
  // mode: 'overwrite' replaces chef_data entirely
  //        'append'    merges new rows with deduplication
  async function extractAndStore(mode = 'overwrite') {
    // Wait for lazy-loaded content to render
    await sleep(LAZY_RENDER_MS);

    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    if (chef_columns.length === 0) return;

    const newRows = extractRows(chef_columns);
    if (newRows.length === 0) return;

    let finalData;
    if (mode === 'append') {
      const existing = Array.isArray(chef_data) ? chef_data : [];
      const existingKeys = new Set(existing.map(r => JSON.stringify(r)));
      const unique = newRows.filter(r => !existingKeys.has(JSON.stringify(r)));
      finalData = [...existing, ...unique];
    } else {
      finalData = newRows;
    }

    await chrome.storage.local.set({ chef_data: finalData });
  }

  // ═══════════════════════════════════════════════════════════
  //  3. AUTO-SCROLL & PAGINATION
  // ═══════════════════════════════════════════════════════════

  async function performAutoScroll(targetItems) {
    let prevCount = 0;
    let stallCount = 0;
    const MAX_STALLS = 5;

    for (let tick = 0; tick < targetItems * 3; tick++) {
      // Scroll to bottom
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      await sleep(SCROLL_SETTLE_MS);

      // Extract and append
      await extractAndStore('append');

      // Check progress
      const { chef_data = [] } = await chrome.storage.local.get('chef_data');
      const currentCount = chef_data.length;
      showToast(`Extracting... ${currentCount} / ${targetItems} items`);

      if (currentCount >= targetItems) {
        showToast(`Extraction complete: ${currentCount} items`);
        return;
      }

      // Stall detection: if count didn't increase, we may have hit the end
      if (currentCount === prevCount) {
        stallCount++;
        if (stallCount >= MAX_STALLS) {
          showToast(`Stopped: no new items after ${MAX_STALLS} scrolls (${currentCount} total)`);
          return;
        }
      } else {
        stallCount = 0;
      }
      prevCount = currentCount;
    }
    showToast('Auto-scroll finished');
  }

  async function startPagination() {
    const { is_paginating, pages_left, chef_next_btn } =
      await chrome.storage.local.get(['is_paginating', 'pages_left', 'chef_next_btn']);

    if (!is_paginating || !pages_left || pages_left <= 0) return;

    // Extract current page
    await extractAndStore('append');
    const remaining = pages_left - 1;
    await chrome.storage.local.set({ pages_left: remaining });

    if (remaining > 0 && chef_next_btn) {
      const nextBtn = safeQuerySelector(chef_next_btn);
      if (nextBtn) {
        showToast(`Paginating... ${remaining} pages left`);
        nextBtn.click();
        // The next page load will re-trigger startPagination via the load listener
      } else {
        showToast('Next-page button not found. Stopping.');
        await chrome.storage.local.set({ is_paginating: false });
      }
    } else {
      showToast('Pagination complete');
      await chrome.storage.local.set({ is_paginating: false });
    }
  }

  // Resume pagination on page load (for multi-page navigation)
  window.addEventListener('load', async () => {
    const { is_paginating } = await chrome.storage.local.get('is_paginating');
    if (is_paginating) {
      await sleep(PAGE_SETTLE_MS);
      startPagination();
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  MESSAGE ROUTER
  // ═══════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;

    switch (msg.action) {
      case 'select_element':
        startSelectionMode(msg.column);
        sendResponse({ ok: true });
        break;

      case 'select_next_btn':
        startSelectionMode('next_btn');
        sendResponse({ ok: true });
        break;

      case 'auto_scroll':
        performAutoScroll(msg.target);
        sendResponse({ ok: true });
        break;

      case 'scrape_and_paginate':
        startPagination();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }
    return true; // keep message channel open for async
  });

  // ═══════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function showToast(message) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.style.cssText =
        'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
        'background:#f7d74a;color:#1a1a1a;padding:10px 20px;border-radius:8px;' +
        'font-weight:800;z-index:2147483647;font-family:sans-serif;font-size:13px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.3s;pointer-events:none;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }
})();
