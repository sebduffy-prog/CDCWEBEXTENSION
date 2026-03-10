/* ============================================================
   Chef de Commis v5.0.0 — Popup Controller
   ============================================================ */

(function () {
  'use strict';

  // ── DOM References ──────────────────────────────────────────
  const elColumnName    = document.getElementById('new-column-name');
  const elAddColumn     = document.getElementById('btn-add-column');
  const elColumnsWrap   = document.getElementById('columns-container');
  const elScrollCount   = document.getElementById('scroll-count');
  const elAutoScroll    = document.getElementById('btn-auto-scroll');
  const elSelectNext    = document.getElementById('btn-select-next');
  const elNextStatus    = document.getElementById('next-btn-status');
  const elPageCount     = document.getElementById('page-count');
  const elAutoPaginate  = document.getElementById('btn-auto-paginate');
  const elFormat        = document.getElementById('btn-format');
  const elOutput        = document.getElementById('output-preview');
  const elDownload      = document.getElementById('btn-download');
  const elClear         = document.getElementById('btn-clear');

  // ── Helpers ─────────────────────────────────────────────────

  /** Send a message to the active tab's content script. */
  function sendToContent(message, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, message, function (response) {
        if (chrome.runtime.lastError) {
          console.warn('sendToContent error:', chrome.runtime.lastError.message);
        }
        if (callback) callback(response);
      });
    });
  }

  /** Read keys from chrome.storage.local. */
  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, resolve);
    });
  }

  /** Write to chrome.storage.local. */
  function storageSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  }

  // ── Aggressive Sanitizer ────────────────────────────────────

  /**
   * Strips URLs, HTML tags, line breaks, leading/trailing whitespace,
   * and common social-media UI noise from a string.
   */
  function sanitize(raw) {
    if (raw === null || raw === undefined) return '';
    var s = String(raw);

    // Strip URLs
    s = s.replace(/https?:\/\/[^\s]+/gi, '');

    // Strip HTML tags
    s = s.replace(/<[^>]*>/g, '');

    // Decode common HTML entities
    s = s.replace(/&amp;/g, '&');
    s = s.replace(/&lt;/g, '<');
    s = s.replace(/&gt;/g, '>');
    s = s.replace(/&quot;/g, '"');
    s = s.replace(/&#039;/g, "'");
    s = s.replace(/&nbsp;/g, ' ');

    // Strip line breaks and collapse whitespace
    s = s.replace(/[\r\n]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ');

    // Social-media UI noise patterns
    s = s.replace(/\b\d+\s*points?\b/gi, '');
    s = s.replace(/\b(Reply|Share|Upvote|Downvote|Report|Save|Hide|Bookmark|Flag|Like|Likes|Comment|Comments|Retweet|Retweets|Repost|Reposts)\b/gi, '');
    s = s.replace(/\b\d+\s*(replies|comments|shares|likes|retweets|reposts|views)\b/gi, '');

    // Collapse leftover whitespace and trim
    s = s.replace(/\s{2,}/g, ' ').trim();

    return s;
  }

  // ── Render Column Rows ──────────────────────────────────────

  async function renderColumns() {
    var result = await storageGet(['chef_columns', 'chef_data', 'chef_next_btn']);
    var columns = result.chef_columns || [];
    var data    = result.chef_data || {};
    var nextBtn = result.chef_next_btn || null;

    // Columns list
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
        '<button class="btn-outline text-xs rounded px-2 py-0.5 btn-select" data-col="' + escapeHtml(col.name) + '">Select</button>' +
        '<button class="bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded px-2 py-0.5 btn-remove" data-idx="' + idx + '">&times;</button>';

      elColumnsWrap.appendChild(row);
    });

    // Bind select buttons
    elColumnsWrap.querySelectorAll('.btn-select').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var colName = btn.getAttribute('data-col');
        sendToContent({ action: 'select_element', column: colName });
        window.close();
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
      elNextStatus.classList.remove('text-zinc-500');
      elNextStatus.classList.add('text-green-400');
    } else {
      elNextStatus.classList.remove('text-green-400');
      elNextStatus.classList.add('text-zinc-500');
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  // ── Add Column ──────────────────────────────────────────────

  elAddColumn.addEventListener('click', async function () {
    var name = elColumnName.value.trim();
    if (!name) return;

    var result = await storageGet(['chef_columns']);
    var columns = result.chef_columns || [];

    // Prevent duplicates
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

  // Allow Enter key to add column
  elColumnName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') elAddColumn.click();
  });

  // ── Select Next-Page Button ─────────────────────────────────

  elSelectNext.addEventListener('click', function () {
    sendToContent({ action: 'select_next_btn' });
    window.close();
  });

  // ── Auto-Scroll ─────────────────────────────────────────────

  elAutoScroll.addEventListener('click', function () {
    var scrolls = parseInt(elScrollCount.value, 10) || 5;
    sendToContent({ action: 'auto_scroll', scrolls: scrolls });
    window.close();
  });

  // ── Auto-Paginate ───────────────────────────────────────────

  elAutoPaginate.addEventListener('click', async function () {
    var pages = parseInt(elPageCount.value, 10) || 3;
    await storageSet({ is_paginating: true, pages_left: pages });
    sendToContent({ action: 'scrape_and_paginate' });
    window.close();
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

    // Find the longest array for total row count
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
      ['chef_columns', 'chef_data', 'chef_next_btn', 'is_paginating', 'pages_left'],
      function () {
        elOutput.value = '';
        renderColumns();
      }
    );
  });

  // ── Listen for storage changes to live-refresh ──────────────

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') {
      renderColumns();
    }
  });

  // ── Initial Render ──────────────────────────────────────────
  renderColumns();

})();
