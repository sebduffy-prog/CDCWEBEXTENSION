/* ============================================================
   Chef de Commis v5.1.0 — Content Script (The Engine)
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  var HIGHLIGHT_CLASS  = '__cdc_highlight__';
  var STYLE_ID         = '__cdc_style__';
  var OVERLAY_ID       = '__cdc_scrape_overlay__';

  // ── Utility: Storage helpers ────────────────────────────────

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ── Selector Math ───────────────────────────────────────────

  function computeSelector(el) {
    if (el.id) {
      return '#' + CSS.escape(el.id);
    }

    function buildSimple(node) {
      var tag = node.tagName.toLowerCase();
      var classes = Array.from(node.classList)
        .filter(function (c) { return c !== HIGHLIGHT_CLASS && !c.startsWith('__cdc'); })
        .map(function (c) { return '.' + CSS.escape(c); })
        .join('');
      return tag + classes;
    }

    var selfSelector = buildSimple(el);

    try {
      if (document.querySelectorAll(selfSelector).length === 1) {
        return selfSelector;
      }
    } catch (e) { /* fall through */ }

    if (el.parentElement) {
      var parentSel = buildSimple(el.parentElement);
      var combo = parentSel + ' > ' + selfSelector;
      try {
        if (document.querySelectorAll(combo).length >= 1) {
          return combo;
        }
      } catch (e) { /* fall through */ }
    }

    var parts = [];
    var current = el;
    for (var depth = 0; depth < 4 && current && current !== document.body; depth++) {
      var parent = current.parentElement;
      if (!parent) break;
      var children = Array.from(parent.children);
      var index = children.indexOf(current) + 1;
      parts.unshift(buildSimple(current) + ':nth-child(' + index + ')');
      current = parent;
    }

    return parts.join(' > ');
  }

  // ── Extract Data for a Column ───────────────────────────────

  function extractBySelector(selector) {
    if (!selector) return [];
    try {
      var nodes = document.querySelectorAll(selector);
      return Array.from(nodes).map(function (n) {
        return n.innerText || n.textContent || '';
      });
    } catch (e) {
      console.warn('Chef de Commis: invalid selector', selector, e);
      return [];
    }
  }

  // ── Extract All Columns ─────────────────────────────────────

  async function extractAllColumns() {
    var result = await storageGet(['chef_columns', 'chef_data']);
    var columns = result.chef_columns || [];
    var data    = result.chef_data || {};

    columns.forEach(function (col) {
      if (!col.cssSelector) return;
      var fresh = extractBySelector(col.cssSelector);
      var existing = data[col.name] || [];
      var merged = existing.concat(fresh);
      var seen = {};
      data[col.name] = merged.filter(function (item) {
        var trimmed = item.trim();
        if (trimmed === '') return false;
        if (seen[trimmed]) return false;
        seen[trimmed] = true;
        return true;
      });
    });

    await storageSet({ chef_data: data });
    return data;
  }

  /**
   * Count the minimum number of valid items across all mapped columns.
   * This represents the "complete rows" extracted so far.
   */
  function countExtractedItems(data, columns) {
    var counts = [];
    columns.forEach(function (col) {
      if (!col.cssSelector) return;
      var arr = data[col.name] || [];
      counts.push(arr.length);
    });
    if (counts.length === 0) return 0;
    return Math.max.apply(null, counts);
  }

  // ── Highlight Injection / Removal ───────────────────────────

  function injectHighlightCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + HIGHLIGHT_CLASS + ' { outline: 3px solid #f7d74a !important; cursor: crosshair !important; }' +
      '.' + HIGHLIGHT_CLASS + ':hover { outline: 3px solid #e5c63e !important; background-color: rgba(247,215,74,0.08) !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  function removeHighlightCSS() {
    var style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(function (el) {
      el.classList.remove(HIGHLIGHT_CLASS);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  FEATURE 2: Native Selection Mode (viewport border + badge)
  // ═══════════════════════════════════════════════════════════

  var BORDER_ID = '__cdc_viewport_border__';
  var BADGE_ID  = '__cdc_selection_badge__';

  var selectionField   = null;
  var selectionActive  = false;
  var hoverTarget      = null;

  function createSelectionIndicator(fieldName) {
    removeSelectionIndicator();

    // Viewport border — 5px solid yellow around the inner window
    var border = document.createElement('div');
    border.id = BORDER_ID;
    Object.assign(border.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      border: '5px solid #FFCC00',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      zIndex: '999999'
    });
    document.body.appendChild(border);

    // Top-center badge
    var badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.textContent = 'Targeting element for: ' + fieldName;
    Object.assign(badge.style, {
      position: 'fixed',
      top: '8px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: '#1A1A1A',
      color: '#FFCC00',
      padding: '6px 16px',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '700',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      zIndex: '999999',
      pointerEvents: 'none',
      whiteSpace: 'nowrap'
    });
    document.body.appendChild(badge);
  }

  function removeSelectionIndicator() {
    var border = document.getElementById(BORDER_ID);
    if (border) border.remove();
    var badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
  }

  // ── Selection Mode Handlers ─────────────────────────────────

  function onSelMouseOver(e) {
    if (!selectionActive) return;
    if (hoverTarget) hoverTarget.classList.remove(HIGHLIGHT_CLASS);
    hoverTarget = e.target;
    hoverTarget.classList.add(HIGHLIGHT_CLASS);
  }

  function onSelMouseOut(e) {
    if (!selectionActive) return;
    if (e.target) e.target.classList.remove(HIGHLIGHT_CLASS);
  }

  function onSelClick(e) {
    if (!selectionActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var target = e.target;

    // Remove the highlight class before computing the selector
    target.classList.remove(HIGHLIGHT_CLASS);
    var selector = computeSelector(target);

    // Tear down listeners immediately
    selectionActive = false;
    document.removeEventListener('mouseover', onSelMouseOver, true);
    document.removeEventListener('mouseout', onSelMouseOut, true);
    document.removeEventListener('click', onSelClick, true);
    document.removeEventListener('keydown', onSelKeydown, true);

    // Clean up visual indicators
    removeHighlightCSS();
    removeSelectionIndicator();

    // Determine which field we're saving for
    var field = selectionField;

    // Save the selector to fieldSelectors AND update chef_columns in one go
    storageGet(['fieldSelectors', 'chef_columns', 'chef_next_btn']).then(function (result) {
      var selectors = result.fieldSelectors || {};
      var columns   = result.chef_columns || [];
      var nextBtn   = result.chef_next_btn || null;

      // Save to fieldSelectors
      selectors[field] = selector;

      // Also update the matching column's cssSelector directly
      if (field === '__next_btn__') {
        nextBtn = selector;
      } else {
        columns.forEach(function (col) {
          if (col.name === field) {
            col.cssSelector = selector;
          }
        });
      }

      return storageSet({
        fieldSelectors: selectors,
        chef_columns: columns,
        chef_next_btn: nextBtn,
        activeSelectionField: ''
      });
    }).then(function () {
      // Now extract data immediately with the updated selector
      return extractAllColumns();
    }).then(function () {
      selectionField = null;
      hoverTarget = null;

      // Show "Captured!" feedback badge
      var badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.textContent = '\u2705 Captured!';
      Object.assign(badge.style, {
        position: 'fixed',
        top: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: '#22c55e',
        color: '#ffffff',
        padding: '6px 16px',
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: '700',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        zIndex: '999999',
        pointerEvents: 'none',
        whiteSpace: 'nowrap'
      });
      document.body.appendChild(badge);

      setTimeout(function () {
        var b = document.getElementById(BADGE_ID);
        if (b) b.remove();
        chrome.runtime.sendMessage({ action: 'REOPEN_POPUP' });
      }, 800);
    });
  }

  function onSelKeydown(e) {
    if (e.key === 'Escape') {
      cancelSelection();
    }
  }

  function cancelSelection() {
    selectionActive = false;
    document.removeEventListener('mouseover', onSelMouseOver, true);
    document.removeEventListener('mouseout', onSelMouseOut, true);
    document.removeEventListener('click', onSelClick, true);
    document.removeEventListener('keydown', onSelKeydown, true);
    removeHighlightCSS();
    removeSelectionIndicator();
    selectionField = null;
    hoverTarget = null;
  }

  function startSelectionMode(field) {
    // Cancel any prior selection that might still be active
    if (selectionActive) {
      cancelSelection();
    }

    selectionField  = field;
    selectionActive = true;
    hoverTarget     = null;

    // Inject CSS and show visual indicator
    injectHighlightCSS();
    createSelectionIndicator(field);

    // Attach listeners immediately (use capture phase so we
    // intercept clicks before the page's own handlers)
    document.addEventListener('mouseover', onSelMouseOver, true);
    document.addEventListener('mouseout', onSelMouseOut, true);
    document.addEventListener('click', onSelClick, true);
    document.addEventListener('keydown', onSelKeydown, true);

    console.log('Chef de Commis: Selection mode started for "' + field + '"');
  }

  // ═══════════════════════════════════════════════════════════
  //  FEATURE 4: Mixing Bowl Overlay
  // ═══════════════════════════════════════════════════════════

  var __cdc_stop_requested__ = false;

  function createScrapingOverlay() {
    removeScrapingOverlay();
    __cdc_stop_requested__ = false;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(247, 215, 74, 0.35)',
      zIndex: '2147483646',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    });

    // Inject keyframes
    var styleEl = document.createElement('style');
    styleEl.id = '__cdc_overlay_style__';
    styleEl.textContent =
      '@keyframes __cdc_pulse__ {' +
        '0%, 100% { opacity: 1; }' +
        '50% { opacity: 0.4; }' +
      '}';
    document.head.appendChild(styleEl);

    overlay.innerHTML =
      // Large translucent "SCROLL to scrape" text
      '<div style="font-size:72px;font-weight:900;color:rgba(26,26,26,0.18);text-align:center;letter-spacing:4px;text-transform:uppercase;user-select:none;line-height:1.1;margin-bottom:32px;">' +
        'SCROLL<br>to scrape' +
      '</div>' +
      // Stop scraping button (needs pointer events)
      '<button id="__cdc_stop_btn__" style="pointer-events:auto;padding:14px 40px;font-size:18px;font-weight:900;color:#fff;background:#c0392b;border:none;border-radius:8px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.25);letter-spacing:1px;text-transform:uppercase;">' +
        'Stop Scraping' +
      '</button>' +
      // Status text
      '<div id="__cdc_overlay_text__" style="font-size:16px;font-weight:800;color:#1A1A1A;text-align:center;margin-top:24px;animation:__cdc_pulse__ 1.5s ease-in-out infinite;">' +
        'Chef de Commis is extracting data...' +
      '</div>' +
      '<div id="__cdc_overlay_count__" style="font-size:14px;font-weight:700;color:#5a4e00;margin-top:8px;font-family:\'Courier New\',monospace;">' +
        '0 / ? items' +
      '</div>';

    document.body.appendChild(overlay);

    // Wire up stop button
    var stopBtn = document.getElementById('__cdc_stop_btn__');
    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        __cdc_stop_requested__ = true;
        stopBtn.textContent = 'Stopping...';
        stopBtn.disabled = true;
        stopBtn.style.opacity = '0.6';
      });
    }

    return overlay;
  }

  function updateOverlayCount(current, target) {
    var el = document.getElementById('__cdc_overlay_count__');
    if (el) el.textContent = current + ' / ' + target + ' items';
  }

  function removeScrapingOverlay() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    var style = document.getElementById('__cdc_overlay_style__');
    if (style) style.remove();
  }

  // ═══════════════════════════════════════════════════════════
  //  FEATURE 3: Target-Based Auto-Scrolling
  // ═══════════════════════════════════════════════════════════

  /**
   * Wait for new DOM nodes to appear (via MutationObserver) or timeout.
   */
  function waitForDOMMutation(timeoutMs) {
    return new Promise(function (resolve) {
      var resolved = false;
      var observer = new MutationObserver(function () {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        resolve();
      }, timeoutMs || 3000);
    });
  }

  async function performTargetExtraction(targetCount) {
    createScrapingOverlay();
    updateOverlayCount(0, targetCount);

    var result = await storageGet(['chef_columns']);
    var columns = result.chef_columns || [];
    var mappedColumns = columns.filter(function (c) { return !!c.cssSelector; });

    if (mappedColumns.length === 0) {
      removeScrapingOverlay();
      alert('Chef de Commis: No columns mapped. Map at least one column first.');
      return;
    }

    var maxAttempts = targetCount * 3; // Safety cap to prevent infinite loops
    var attempts = 0;
    var currentCount = 0;

    while (currentCount < targetCount && attempts < maxAttempts) {
      if (__cdc_stop_requested__) break;

      // Extract data
      var data = await extractAllColumns();
      currentCount = countExtractedItems(data, columns);
      updateOverlayCount(currentCount, targetCount);

      if (currentCount >= targetCount) break;
      if (__cdc_stop_requested__) break;

      // Scroll down visibly
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth'
      });

      // Wait for new content to load
      await delay(800);
      await waitForDOMMutation(2500);
      await delay(500);

      attempts++;
    }

    // Final extraction pass
    var finalData = await extractAllColumns();
    var finalCount = countExtractedItems(finalData, columns);
    updateOverlayCount(finalCount, targetCount);

    // Brief pause to show final count
    await delay(1000);
    removeScrapingOverlay();
  }

  // ── Pagination Engine (runs on page load) ───────────────────

  async function checkPagination() {
    var result = await storageGet(['is_paginating', 'pages_left', 'chef_columns', 'chef_next_btn']);

    if (!result.is_paginating || !result.pages_left || result.pages_left <= 0) return;

    var pagesLeft = result.pages_left;
    var nextSel   = result.chef_next_btn;

    if (!nextSel) {
      alert('Chef de Commis: No "Next Page" button selector saved. Stopping.');
      await storageSet({ is_paginating: false, pages_left: 0 });
      return;
    }

    await delay(2000);
    await extractAllColumns();

    pagesLeft--;
    await storageSet({ pages_left: pagesLeft });

    if (pagesLeft <= 0) {
      await storageSet({ is_paginating: false });
      alert('Chef de Commis: Pagination Complete! All pages scraped.');
      return;
    }

    var nextBtn = null;
    try {
      nextBtn = document.querySelector(nextSel);
    } catch (e) {
      console.warn('Chef de Commis: invalid next-btn selector', e);
    }

    if (!nextBtn) {
      alert('Chef de Commis: Could not find "Next Page" button on this page. Stopping.');
      await storageSet({ is_paginating: false, pages_left: 0 });
      return;
    }

    nextBtn.click();
  }

  // ── Scrape Current Page + Click Next ────────────────────────

  async function scrapeAndPaginate() {
    var result = await storageGet(['chef_next_btn', 'pages_left']);
    var nextSel = result.chef_next_btn;

    if (!nextSel) {
      alert('Chef de Commis: No "Next Page" button selector set. Select it first.');
      return;
    }

    await extractAllColumns();

    var left = (result.pages_left || 1) - 1;
    await storageSet({ pages_left: left });

    if (left <= 0) {
      await storageSet({ is_paginating: false });
      alert('Chef de Commis: Pagination Complete!');
      return;
    }

    var nextBtn = null;
    try {
      nextBtn = document.querySelector(nextSel);
    } catch (e) {
      console.warn('Chef de Commis: invalid next-btn selector', e);
    }

    if (!nextBtn) {
      alert('Chef de Commis: "Next Page" button not found. Stopping.');
      await storageSet({ is_paginating: false, pages_left: 0 });
      return;
    }

    nextBtn.click();
  }

  // ── Event Listeners (from popup via chrome.scripting) ───────

  window.addEventListener('__cdc_start_extraction__', function (e) {
    var detail = e.detail || {};
    performTargetExtraction(detail.targetCount || 20);
  });

  window.addEventListener('__cdc_scrape_and_paginate__', function () {
    scrapeAndPaginate();
  });

  // ── Message Listener ──────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) return;

    switch (msg.action) {
      case 'PING':
        sendResponse({ pong: true });
        break;

      case 'START_SELECTION':
        startSelectionMode(msg.field);
        sendResponse({ ok: true });
        break;

      case 'auto_scroll':
        performTargetExtraction(msg.targetCount || msg.scrolls || 20);
        sendResponse({ ok: true });
        break;

      case 'scrape_and_paginate':
        scrapeAndPaginate();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }
  });

  // ── On Page Load: Check for pending selection & pagination ──

  // If the popup closed before the message arrived, check storage
  // for a pending selection request.
  storageGet(['activeSelectionField']).then(function (result) {
    if (result.activeSelectionField) {
      startSelectionMode(result.activeSelectionField);
    }
  });

  checkPagination();

  console.log('Chef de Commis: Content script loaded and ready.');

})();
