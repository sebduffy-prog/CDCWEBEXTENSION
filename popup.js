/* ============================================================
   Chef de Commis v5.1.0 — Popup Controller
   ============================================================ */

(function () {
  'use strict';

  // ── DOM References ──────────────────────────────────────────
  var elColumnName    = document.getElementById('new-column-name');
  var elAddColumn     = document.getElementById('btn-add-column');
  var elColumnsWrap   = document.getElementById('columns-container');
  var elTargetCount   = document.getElementById('target-count');
  var elAutoScroll    = document.getElementById('btn-auto-scroll');
  var elSelectNext    = document.getElementById('btn-select-next');
  var elNextStatus    = document.getElementById('next-btn-status');
  var elPageCount     = document.getElementById('page-count');
  var elAutoPaginate  = document.getElementById('btn-auto-paginate');
  var elFormat        = document.getElementById('btn-format');
  var elOutput        = document.getElementById('output-preview');
  var elDownload      = document.getElementById('btn-download');
  var elClear         = document.getElementById('btn-clear');

  // ── Helpers ─────────────────────────────────────────────────

  function getActiveTabId(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      callback(tabs[0].id);
    });
  }

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

  // ── Aggressive Sanitizer ────────────────────────────────────

  function sanitize(raw) {
    if (raw === null || raw === undefined) return '';
    var s = String(raw);
    s = s.replace(/https?:\/\/[^\s]+/gi, '');
    s = s.replace(/<[^>]*>/g, '');
    s = s.replace(/&amp;/g, '&');
    s = s.replace(/&lt;/g, '<');
    s = s.replace(/&gt;/g, '>');
    s = s.replace(/&quot;/g, '"');
    s = s.replace(/&#039;/g, "'");
    s = s.replace(/&nbsp;/g, ' ');
    s = s.replace(/[\r\n]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ');
    s = s.replace(/\b\d+\s*points?\b/gi, '');
    s = s.replace(/\b(Reply|Share|Upvote|Downvote|Report|Save|Hide|Bookmark|Flag|Like|Likes|Comment|Comments|Retweet|Retweets|Repost|Reposts)\b/gi, '');
    s = s.replace(/\b\d+\s*(replies|comments|shares|likes|retweets|reposts|views)\b/gi, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  // ── Render Column Rows ──────────────────────────────────────

  async function renderColumns() {
    var result = await storageGet(['chef_columns', 'chef_data', 'chef_next_btn', 'fieldSelectors']);
    var columns = result.chef_columns || [];
    var data    = result.chef_data || {};
    var nextBtn = result.chef_next_btn || null;
    var fieldSelectors = result.fieldSelectors || {};

    // Hydrate columns with any selectors saved via the native selection flow
    var dirty = false;
    columns.forEach(function (col) {
      if (fieldSelectors[col.name] && col.cssSelector !== fieldSelectors[col.name]) {
        col.cssSelector = fieldSelectors[col.name];
        dirty = true;
      }
    });
    // Hydrate the next-button selector
    if (fieldSelectors['__next_btn__'] && nextBtn !== fieldSelectors['__next_btn__']) {
      nextBtn = fieldSelectors['__next_btn__'];
      dirty = true;
    }
    if (dirty) {
      await storageSet({ chef_columns: columns, chef_next_btn: nextBtn });
    }

    elColumnsWrap.innerHTML = '';
    columns.forEach(function (col, idx) {
      var count = (data[col.name] && data[col.name].length) || 0;
      var mapped = !!col.cssSelector;

      var row = document.createElement('div');
      row.className = 'column-row';

      row.innerHTML =
        '<span class="status-dot ' + (mapped ? 'status-mapped' : 'status-unmapped') + '"></span>' +
        '<span class="col-name" title="' + escapeHtml(col.name) + '">' + escapeHtml(col.name) + '</span>' +
        '<span class="col-selector" title="' + escapeHtml(col.cssSelector || 'unmapped') + '">' + escapeHtml(col.cssSelector || 'unmapped') + '</span>' +
        '<span class="col-count">' + count + ' items</span>' +
        '<button class="btn-sm btn-select-col btn-select" data-col="' + escapeHtml(col.name) + '">Select</button>' +
        '<button class="btn-sm btn-remove-col btn-remove" data-idx="' + idx + '">&times;</button>';

      elColumnsWrap.appendChild(row);
    });

    // Bind select buttons — start native selection flow
    elColumnsWrap.querySelectorAll('.btn-select').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var colName = btn.getAttribute('data-col');
        startFieldSelection('column', colName);
      });
    });

    // Bind remove buttons
    elColumnsWrap.querySelectorAll('.btn-remove').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var res = await storageGet(['chef_columns', 'chef_data']);
        var cols = res.chef_columns || [];
        var d = res.chef_data || {};
        var removed = cols.splice(idx, 1);
        if (removed.length && d[removed[0].name]) {
          delete d[removed[0].name];
        }
        await storageSet({ chef_columns: cols, chef_data: d });
        renderColumns();
      });
    });

    // Next-button status
    elNextStatus.textContent = nextBtn ? nextBtn : 'Not set';
    if (nextBtn) {
      elNextStatus.className = 'status-text status-set';
    } else {
      elNextStatus.className = 'status-text status-unset';
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  // ── Native Selection Flow ───────────────────────────────────
  // Save the active field to storage, message content.js to start
  // selection mode, then let the popup close naturally.

  function startFieldSelection(mode, columnName) {
    var fieldName = mode === 'next_btn' ? '__next_btn__' : columnName;
    storageSet({ activeSelectionField: fieldName }).then(function () {
      getActiveTabId(function (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: 'START_SELECTION',
          field: fieldName
        });
        window.close();
      });
    });
  }

  // ── Add Column ──────────────────────────────────────────────

  elAddColumn.addEventListener('click', async function () {
    var name = elColumnName.value.trim();
    if (!name) return;

    var result = await storageGet(['chef_columns']);
    var columns = result.chef_columns || [];

    var exists = columns.some(function (c) { return c.name === name; });
    if (exists) {
      alert('Column "' + name + '" already exists.');
      return;
    }

    columns.push({ name: name, cssSelector: '' });
    await storageSet({ chef_columns: columns });
    elColumnName.value = '';
    renderColumns();
  });

  elColumnName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') elAddColumn.click();
  });

  // ── Select Next-Page Button ─────────────────────────────────

  elSelectNext.addEventListener('click', function () {
    startFieldSelection('next_btn', '');
  });

  // ── Auto-Scroll (Target-Based) ──────────────────────────────

  elAutoScroll.addEventListener('click', function () {
    var target = parseInt(elTargetCount.value, 10) || 20;
    getActiveTabId(function (tabId) {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        args: [target],
        func: function (targetCount) {
          window.dispatchEvent(new CustomEvent('__cdc_start_extraction__', {
            detail: { targetCount: targetCount }
          }));
        }
      });
    });
  });

  // ── Auto-Paginate ───────────────────────────────────────────

  elAutoPaginate.addEventListener('click', async function () {
    var pages = parseInt(elPageCount.value, 10) || 3;
    await storageSet({ is_paginating: true, pages_left: pages });
    getActiveTabId(function (tabId) {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          window.dispatchEvent(new CustomEvent('__cdc_scrape_and_paginate__'));
        }
      });
    });
  });

  // ── Format & Prepare Data ───────────────────────────────────

  elFormat.addEventListener('click', async function () {
    var result = await storageGet(['chef_columns', 'chef_data']);
    var columns = result.chef_columns || [];
    var data    = result.chef_data || {};

    if (columns.length === 0) {
      elOutput.value = '[ No columns defined. Add columns in Step 1. ]';
      return;
    }

    var maxRows = 0;
    columns.forEach(function (col) {
      var arr = data[col.name] || [];
      if (arr.length > maxRows) maxRows = arr.length;
    });

    if (maxRows === 0) {
      elOutput.value = '[ No data scraped yet. Use Step 2 to scrape. ]';
      return;
    }

    var lines = [];
    for (var i = 0; i < maxRows; i++) {
      columns.forEach(function (col) {
        var arr = data[col.name] || [];
        var raw = i < arr.length ? arr[i] : '';
        var clean = sanitize(raw);
        lines.push(col.name + ': ' + clean);
      });
      lines.push('---');
    }

    elOutput.value = lines.join('\n');
  });

  // ── Download UTF-8 .txt ─────────────────────────────────────

  elDownload.addEventListener('click', function () {
    var text = elOutput.value;
    if (!text || !text.trim()) {
      alert('Nothing to download. Format your data first.');
      return;
    }

    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url  = URL.createObjectURL(blob);

    chrome.downloads.download({
      url: url,
      filename: 'chef-de-commis-export.txt',
      saveAs: true
    }, function () {
      URL.revokeObjectURL(url);
    });
  });

  // ── Clear All Storage ───────────────────────────────────────

  elClear.addEventListener('click', function () {
    if (!confirm('Clear ALL Chef de Commis data? This cannot be undone.')) return;
    chrome.storage.local.remove(
      ['chef_columns', 'chef_data', 'chef_next_btn', 'is_paginating', 'pages_left', 'fieldSelectors', 'activeSelectionField'],
      function () {
        elOutput.value = '';
        renderColumns();
      }
    );
  });

  // ── Listen for storage changes to live-refresh ──────────────

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && (changes.fieldSelectors || changes.chef_columns || changes.chef_data)) {
      renderColumns();
    }
  });

  // ── Initial Render ──────────────────────────────────────────
  renderColumns();

})();
