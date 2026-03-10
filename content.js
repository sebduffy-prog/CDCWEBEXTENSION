/* ============================================================
   Chef de Commis v5.1.0 — Content Script (The Engine)
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  var HIGHLIGHT_CLASS  = '__cdc_highlight__';
  var STYLE_ID         = '__cdc_style__';
  var PANEL_ID         = '__cdc_selection_panel__';
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
    document.head.appendChild(style);
  }

  function removeHighlightCSS() {
    var style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(function (el) {
      el.classList.remove(HIGHLIGHT_CLASS);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  FEATURE 2: Persistent Floating Selection Panel
  // ═══════════════════════════════════════════════════════════

  var selectionMode    = null;
  var selectionColumn  = null;
  var hoverTarget      = null;
  var capturedSelector = null;

  function createSelectionPanel() {
    removeSelectionPanel();

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div id="__cdc_panel_header__" style="cursor:move;padding:10px 14px;font-weight:800;font-size:14px;color:#1A1A1A;border-bottom:2px solid #d4b83d;user-select:none;">' +
        'Selection Mode Active' +
      '</div>' +
      '<div style="padding:12px 14px;">' +
        '<div style="font-size:11px;color:#1A1A1A;font-weight:600;margin-bottom:6px;">Hovered Selector:</div>' +
        '<div id="__cdc_panel_selector__" style="font-family:\'Courier New\',monospace;font-size:11px;color:#1A1A1A;background:#e5c63e;padding:6px 10px;border-radius:6px;word-break:break-all;min-height:20px;font-weight:600;">Hover over an element...</div>' +
        '<div id="__cdc_panel_actions__" style="display:none;margin-top:10px;display:flex;gap:8px;">' +
          '<button id="__cdc_panel_confirm__" style="flex:1;padding:8px;background:#1A1A1A;color:#FFD700;border:none;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;">Confirm</button>' +
          '<button id="__cdc_panel_cancel__" style="flex:1;padding:8px;background:#5a4e00;color:#f7d74a;border:none;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">Cancel</button>' +
        '</div>' +
      '</div>';

    // Panel styles
    Object.assign(panel.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      width: '300px',
      backgroundColor: '#f7d74a',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      overflow: 'hidden'
    });

    document.body.appendChild(panel);

    // Make panel draggable
    makeDraggable(panel, panel.querySelector('#__cdc_panel_header__'));

    // Hide actions initially until an element is clicked
    panel.querySelector('#__cdc_panel_actions__').style.display = 'none';

    // Cancel button
    panel.querySelector('#__cdc_panel_cancel__').addEventListener('click', function (e) {
      e.stopPropagation();
      cancelSelection();
    });

    // Confirm button
    panel.querySelector('#__cdc_panel_confirm__').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmSelection();
    });

    return panel;
  }

  function removeSelectionPanel() {
    var existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function updatePanelSelector(text) {
    var el = document.getElementById('__cdc_panel_selector__');
    if (el) el.textContent = text;
  }

  function showPanelActions() {
    var el = document.getElementById('__cdc_panel_actions__');
    if (el) el.style.display = 'flex';
  }

  function makeDraggable(panel, handle) {
    var offsetX = 0, offsetY = 0, dragging = false;

    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      offsetX = e.clientX - panel.getBoundingClientRect().left;
      offsetY = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - offsetX) + 'px';
      panel.style.top  = (e.clientY - offsetY) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', function () {
      dragging = false;
    });
  }

  // ── Selection Mode Handlers ─────────────────────────────────

  function onSelMouseOver(e) {
    // Ignore our own panel
    if (e.target.closest('#' + PANEL_ID)) return;

    if (hoverTarget) hoverTarget.classList.remove(HIGHLIGHT_CLASS);
    hoverTarget = e.target;
    hoverTarget.classList.add(HIGHLIGHT_CLASS);

    var sel = computeSelector(hoverTarget);
    updatePanelSelector(sel);
  }

  function onSelMouseOut(e) {
    if (e.target.closest('#' + PANEL_ID)) return;
    if (e.target) e.target.classList.remove(HIGHLIGHT_CLASS);
  }

  function onSelClick(e) {
    // Ignore clicks on our own panel
    if (e.target.closest('#' + PANEL_ID)) return;

    e.preventDefault();
    e.stopPropagation();

    var target = e.target;
    capturedSelector = computeSelector(target);
    updatePanelSelector(capturedSelector);
    showPanelActions();

    // Stop hover tracking after click — user needs to confirm or cancel
    document.removeEventListener('mouseover', onSelMouseOver, true);
    document.removeEventListener('mouseout', onSelMouseOut, true);
    document.removeEventListener('click', onSelClick, true);
  }

  async function confirmSelection() {
    removeHighlightCSS();
    removeSelectionPanel();

    if (!capturedSelector) return;

    if (selectionMode === 'next_btn') {
      await storageSet({ chef_next_btn: capturedSelector });
    } else if (selectionMode === 'column' && selectionColumn) {
      var result = await storageGet(['chef_columns']);
      var columns = result.chef_columns || [];
      columns = columns.map(function (col) {
        if (col.name === selectionColumn) {
          return { name: col.name, cssSelector: capturedSelector };
        }
        return col;
      });
      await storageSet({ chef_columns: columns });
      await extractAllColumns();
    }

    selectionMode   = null;
    selectionColumn = null;
    capturedSelector = null;
  }

  function cancelSelection() {
    document.removeEventListener('mouseover', onSelMouseOver, true);
    document.removeEventListener('mouseout', onSelMouseOut, true);
    document.removeEventListener('click', onSelClick, true);
    removeHighlightCSS();
    removeSelectionPanel();
    selectionMode   = null;
    selectionColumn = null;
    capturedSelector = null;
  }

  function startSelectionMode(mode, columnName) {
    selectionMode   = mode;
    selectionColumn = columnName || null;
    hoverTarget     = null;
    capturedSelector = null;

    createSelectionPanel();
    injectHighlightCSS();
    document.addEventListener('mouseover', onSelMouseOver, true);
    document.addEventListener('mouseout', onSelMouseOut, true);
    document.addEventListener('click', onSelClick, true);
  }

  // ═══════════════════════════════════════════════════════════
  //  FEATURE 4: Mixing Bowl Overlay
  // ═══════════════════════════════════════════════════════════

  function createScrapingOverlay() {
    removeScrapingOverlay();

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(247, 215, 74, 0.85)',
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
      '@keyframes __cdc_stir__ {' +
        '0% { transform: rotate(0deg); }' +
        '100% { transform: rotate(360deg); }' +
      '}' +
      '@keyframes __cdc_pulse__ {' +
        '0%, 100% { opacity: 1; }' +
        '50% { opacity: 0.4; }' +
      '}';
    document.head.appendChild(styleEl);

    // SVG Mixing Bowl with spinning whisk
    overlay.innerHTML =
      '<div style="position:relative;width:160px;height:160px;margin-bottom:20px;">' +
        // Bowl body
        '<svg viewBox="0 0 160 160" width="160" height="160" style="position:absolute;top:0;left:0;">' +
          // Bowl shape
          '<ellipse cx="80" cy="110" rx="65" ry="30" fill="#1A1A1A" />' +
          '<path d="M15 90 Q15 140 80 145 Q145 140 145 90 Z" fill="#1A1A1A" />' +
          '<rect x="15" y="70" width="130" height="25" rx="4" fill="#1A1A1A" />' +
          // Bowl rim highlight
          '<rect x="15" y="68" width="130" height="6" rx="3" fill="#333" />' +
          // Bowl contents (yellow batter)
          '<ellipse cx="80" cy="82" rx="55" ry="10" fill="#e5c63e" opacity="0.6" />' +
        '</svg>' +
        // Spinning whisk
        '<div style="position:absolute;top:-10px;left:50%;transform-origin:50% 90px;animation:__cdc_stir__ 1.2s linear infinite;">' +
          '<svg viewBox="0 0 40 100" width="40" height="100" style="margin-left:-20px;">' +
            // Whisk handle
            '<rect x="17" y="0" width="6" height="50" rx="3" fill="#555" />' +
            // Whisk wires
            '<ellipse cx="20" cy="70" rx="12" ry="20" fill="none" stroke="#888" stroke-width="2" />' +
            '<ellipse cx="20" cy="70" rx="6" ry="20" fill="none" stroke="#888" stroke-width="2" />' +
            '<line x1="20" y1="50" x2="20" y2="90" stroke="#888" stroke-width="2" />' +
          '</svg>' +
        '</div>' +
      '</div>' +
      // Status text
      '<div id="__cdc_overlay_text__" style="font-size:18px;font-weight:800;color:#1A1A1A;text-align:center;animation:__cdc_pulse__ 1.5s ease-in-out infinite;">' +
        'Chef de Commis is extracting data...' +
      '</div>' +
      '<div id="__cdc_overlay_count__" style="font-size:14px;font-weight:700;color:#5a4e00;margin-top:8px;font-family:\'Courier New\',monospace;">' +
        '0 / ? items' +
      '</div>';

    document.body.appendChild(overlay);
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
      // Extract data
      var data = await extractAllColumns();
      currentCount = countExtractedItems(data, columns);
      updateOverlayCount(currentCount, targetCount);

      if (currentCount >= targetCount) break;

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

  window.addEventListener('__cdc_start_selection__', function (e) {
    var detail = e.detail || {};
    startSelectionMode(detail.mode, detail.column);
  });

  window.addEventListener('__cdc_start_extraction__', function (e) {
    var detail = e.detail || {};
    performTargetExtraction(detail.targetCount || 20);
  });

  window.addEventListener('__cdc_scrape_and_paginate__', function () {
    scrapeAndPaginate();
  });

  // ── Message Listener (legacy support) ──────────────────────

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) return;

    switch (msg.action) {
      case 'select_element':
        startSelectionMode('column', msg.column);
        sendResponse({ ok: true });
        break;

      case 'select_next_btn':
        startSelectionMode('next_btn');
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

  // ── On Page Load: Check if we're mid-pagination ─────────────
  checkPagination();

})();
