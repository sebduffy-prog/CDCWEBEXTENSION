/* ============================================================
   Chef de Commis v5.0.0 — Content Script (The Engine)
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  var HIGHLIGHT_CLASS = '__cdc_highlight__';
  var STYLE_ID        = '__cdc_style__';

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

  // ── Utility: Delay ──────────────────────────────────────────

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ── Selector Math ───────────────────────────────────────────

  /**
   * Generate a robust CSS selector for an element.
   * Strategy: tag.class1.class2 — if that matches multiple elements,
   * walk up to parent and produce parent > child selector.
   * Final fallback: nth-child chain.
   */
  function computeSelector(el) {
    if (el.id) {
      return '#' + CSS.escape(el.id);
    }

    // Build a tag.class selector
    function buildSimple(node) {
      var tag = node.tagName.toLowerCase();
      var classes = Array.from(node.classList)
        .filter(function (c) { return c !== HIGHLIGHT_CLASS && !c.startsWith('__cdc'); })
        .map(function (c) { return '.' + CSS.escape(c); })
        .join('');
      return tag + classes;
    }

    var selfSelector = buildSimple(el);

    // If unique on the page, use it
    try {
      if (document.querySelectorAll(selfSelector).length === 1) {
        return selfSelector;
      }
    } catch (e) { /* invalid selector, fall through */ }

    // Try parent > child
    if (el.parentElement) {
      var parentSel = buildSimple(el.parentElement);
      var combo = parentSel + ' > ' + selfSelector;
      try {
        if (document.querySelectorAll(combo).length >= 1) {
          return combo;
        }
      } catch (e) { /* fall through */ }
    }

    // Fallback: nth-child path (up to 4 levels)
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

  /**
   * Given a CSS selector, query all matching elements and return
   * an array of their text content.
   */
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

  /**
   * For every saved column that has a cssSelector, extract data
   * and deduplicate+append into chef_data.
   */
  async function extractAllColumns() {
    var result = await storageGet(['chef_columns', 'chef_data']);
    var columns = result.chef_columns || [];
    var data    = result.chef_data || {};

    columns.forEach(function (col) {
      if (!col.cssSelector) return;
      var fresh = extractBySelector(col.cssSelector);
      var existing = data[col.name] || [];
      var merged = existing.concat(fresh);
      // Deduplicate while preserving order
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

  // ── Element Selection Mode ──────────────────────────────────

  var selectionMode    = null; // 'column' or 'next_btn'
  var selectionColumn  = null; // column name when mode === 'column'
  var hoverTarget      = null;

  function onMouseOver(e) {
    if (hoverTarget) hoverTarget.classList.remove(HIGHLIGHT_CLASS);
    hoverTarget = e.target;
    hoverTarget.classList.add(HIGHLIGHT_CLASS);
  }

  function onMouseOut(e) {
    if (e.target) e.target.classList.remove(HIGHLIGHT_CLASS);
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();

    var target = e.target;
    var selector = computeSelector(target);

    // Clean up selection mode
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    removeHighlightCSS();

    if (selectionMode === 'next_btn') {
      // Save selector for the next-page button
      await storageSet({ chef_next_btn: selector });
      selectionMode = null;
      return;
    }

    if (selectionMode === 'column' && selectionColumn) {
      // Save selector for this column
      var result = await storageGet(['chef_columns']);
      var columns = result.chef_columns || [];
      columns = columns.map(function (col) {
        if (col.name === selectionColumn) {
          return { name: col.name, cssSelector: selector };
        }
        return col;
      });
      await storageSet({ chef_columns: columns });

      // Immediately extract initial data for this column
      await extractAllColumns();

      selectionMode   = null;
      selectionColumn = null;
    }
  }

  function startSelectionMode(mode, columnName) {
    selectionMode   = mode;
    selectionColumn = columnName || null;
    hoverTarget     = null;

    injectHighlightCSS();
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
  }

  // ── Auto-Scroll Engine ──────────────────────────────────────

  async function performAutoScroll(scrollCount) {
    for (var i = 0; i < scrollCount; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await delay(1500);
    }

    // After all scrolls, extract data
    await extractAllColumns();
    alert('Chef de Commis: Scroll Complete (' + scrollCount + ' scrolls). Data extracted.');
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

    // Wait for DOM to settle
    await delay(2000);

    // Extract data for all columns
    await extractAllColumns();

    // Decrement pages
    pagesLeft--;
    await storageSet({ pages_left: pagesLeft });

    if (pagesLeft <= 0) {
      // Done
      await storageSet({ is_paginating: false });
      alert('Chef de Commis: Pagination Complete! All pages scraped.');
      return;
    }

    // Click the next button
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

  // ── Scrape Current Page + Click Next (triggered from popup) ─

  async function scrapeAndPaginate() {
    var result = await storageGet(['chef_next_btn', 'pages_left']);
    var nextSel = result.chef_next_btn;

    if (!nextSel) {
      alert('Chef de Commis: No "Next Page" button selector set. Select it first.');
      return;
    }

    // Extract current page
    await extractAllColumns();

    // Decrement
    var left = (result.pages_left || 1) - 1;
    await storageSet({ pages_left: left });

    if (left <= 0) {
      await storageSet({ is_paginating: false });
      alert('Chef de Commis: Pagination Complete!');
      return;
    }

    // Click next
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
    // The next page load will trigger checkPagination() again
  }

  // ── Message Listener ────────────────────────────────────────

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
        performAutoScroll(msg.scrolls || 5);
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
