/* ================================================================
   Chef de Commis v6.0 — Popup Script
   ================================================================
   Architecture:
   1. Storage-driven reactive UI   — chrome.storage.onChanged renders state
   2. Aggressive sanitization       — URLs, HTML, zero-width, social noise
   3. Multi-format export pipeline  — TXT, CSV, DOCX
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // ─── DOM References ────────────────────────────────────────
  const inputColumnName  = document.getElementById('new-column-name');
  const btnAddColumn     = document.getElementById('btn-add-column');
  const columnsContainer = document.getElementById('columns-container');
  const btnAutoScroll    = document.getElementById('btn-auto-scroll');
  const targetCountInput = document.getElementById('target-count');
  const btnSelectNext    = document.getElementById('btn-select-next');
  const btnAutoPaginate  = document.getElementById('btn-auto-paginate');
  const pageCountInput   = document.getElementById('page-count');
  const nextBtnStatus    = document.getElementById('next-btn-status');
  const btnFormat        = document.getElementById('btn-format');
  const outputPreview    = document.getElementById('output-preview');
  const btnDownloadTxt   = document.getElementById('btn-download-txt');
  const btnDownloadCsv   = document.getElementById('btn-download-csv');
  const btnDownloadDocx  = document.getElementById('btn-download-docx');
  const btnClear         = document.getElementById('btn-clear');

  // ─── Initial Render ────────────────────────────────────────
  renderColumns();
  renderNextBtnStatus();

  // ─── Reactive Storage Listener ─────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.chef_columns || changes.chef_data) renderColumns();
    if (changes.chef_next_btn) renderNextBtnStatus();
  });

  // ═══════════════════════════════════════════════════════════
  //  UI EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════

  // --- Add Column ---
  btnAddColumn.addEventListener('click', async () => {
    const name = inputColumnName.value.trim();
    if (!name) return;
    const { chef_columns = [] } = await chrome.storage.local.get('chef_columns');
    if (chef_columns.some(c => c.name === name)) return; // no duplicates
    chef_columns.push({ name, selector: null });
    await chrome.storage.local.set({ chef_columns });
    inputColumnName.value = '';
  });

  // Allow Enter key to add columns
  inputColumnName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnAddColumn.click();
  });

  // --- Select Next-Page Button ---
  btnSelectNext.addEventListener('click', () => {
    sendToContent({ action: 'select_next_btn' });
    window.close();
  });

  // --- Auto-Scroll Extraction ---
  btnAutoScroll.addEventListener('click', () => {
    const target = parseInt(targetCountInput.value, 10) || 20;
    sendToContent({ action: 'auto_scroll', target });
    window.close();
  });

  // --- Auto-Paginate ---
  btnAutoPaginate.addEventListener('click', async () => {
    const pages = parseInt(pageCountInput.value, 10) || 3;
    await chrome.storage.local.set({ is_paginating: true, pages_left: pages });
    sendToContent({ action: 'scrape_and_paginate' });
    window.close();
  });

  // --- Format & Prepare Data ---
  btnFormat.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);

    if (chef_columns.length === 0) {
      outputPreview.value = 'No columns mapped.';
      return;
    }

    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (rows.length === 0) {
      outputPreview.value = 'No data extracted yet.';
      return;
    }

    let output = '';
    for (const row of rows) {
      for (const col of chef_columns) {
        const raw = row[col.name] || 'N/A';
        output += `${col.name}: ${sanitize(raw)}\n`;
      }
      output += '---\n';
    }

    outputPreview.value = output;
  });

  // --- Export TXT ---
  btnDownloadTxt.addEventListener('click', () => {
    const text = outputPreview.value;
    if (!text) return alert('Nothing to download. Format data first.');
    downloadBlob(text, 'text/plain;charset=utf-8', 'Chef_de_Commis_Export.txt');
  });

  // --- Export CSV ---
  btnDownloadCsv.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (chef_columns.length === 0 || rows.length === 0) {
      return alert('No data to export. Extract and format data first.');
    }

    const header = chef_columns.map(c => csvEscape(c.name)).join(',');
    const csvRows = rows.map(row =>
      chef_columns.map(c => csvEscape(sanitize(row[c.name] || 'N/A'))).join(',')
    );
    const csv = [header, ...csvRows].join('\r\n');
    // BOM prefix for Excel UTF-8 compatibility
    downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8', 'Chef_de_Commis_Export.csv');
  });

  // --- Export DOCX ---
  btnDownloadDocx.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (chef_columns.length === 0 || rows.length === 0) {
      return alert('No data to export. Extract and format data first.');
    }

    const buffer = buildDocx(chef_columns, rows);
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'Chef_de_Commis_Export.docx' });
  });

  // --- Clear All ---
  btnClear.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    outputPreview.value = '';
    renderColumns();
    renderNextBtnStatus();
  });

  // ═══════════════════════════════════════════════════════════
  //  AGGRESSIVE SANITIZER
  // ═══════════════════════════════════════════════════════════

  function sanitize(str) {
    if (!str || str === 'N/A') return 'N/A';
    let s = String(str);

    // Strip URLs
    s = s.replace(/https?:\/\/[^\s]+/g, '');

    // Strip HTML tags
    s = s.replace(/<[^>]*>/g, '');

    // Strip zero-width characters
    s = s.replace(/[\u200B-\u200D\u200E\u200F\uFEFF\u00AD]/g, '');

    // Strip social noise — full-line matches
    s = s.replace(/^\s*(Subscribe|Join|Reply|Share|Upvote|Save|Hide|Report|Follow|Like)\s*$/gim, '');

    // Strip social noise — inline occurrences
    s = s.replace(/\b(Subscribe|Join|Reply|Share|Upvote)\b/gi, '');

    // Strip metric lines (e.g. "42 likes", "3 months ago")
    s = s.replace(/^\s*[\d,.]+[KkMm]?\s+(points?|likes?|comments?|shares?|views?|subscribers?|followers?|months?\s+ago|years?\s+ago|hours?\s+ago|days?\s+ago|minutes?\s+ago)\s*$/gim, '');

    // Massive block truncation: >500 chars with >5 line breaks
    const lineBreaks = (s.match(/\n/g) || []).length;
    if (s.length > 500 && lineBreaks > 5) {
      s = s.replace(/\n+/g, ' ').substring(0, 500) + '... [TRUNCATED]';
    }

    // Normalize excessive whitespace
    s = s.replace(/\n{3,}/g, '\n\n');

    return s.trim() || 'N/A';
  }

  // ═══════════════════════════════════════════════════════════
  //  UI RENDERING
  // ═══════════════════════════════════════════════════════════

  async function renderColumns() {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    columnsContainer.innerHTML = '';

    for (const col of chef_columns) {
      const count = rows.filter(r => r[col.name] && r[col.name] !== 'N/A').length;
      const isMapped = !!col.selector;

      const rowEl = document.createElement('div');
      rowEl.className = 'column-row';

      // Status dot
      const dot = document.createElement('span');
      dot.className = `status-dot ${isMapped ? 'status-mapped' : 'status-unmapped'}`;

      // Column name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'col-name';
      nameSpan.textContent = col.name;

      // Selector preview
      const selSpan = document.createElement('span');
      selSpan.className = 'col-selector';
      selSpan.textContent = col.selector ? truncate(col.selector, 30) : 'unmapped';

      // Item count
      const countSpan = document.createElement('span');
      countSpan.className = 'col-count';
      countSpan.textContent = `${count}`;

      // Select button
      const selectBtn = document.createElement('button');
      selectBtn.className = 'btn-sm btn-select-col';
      selectBtn.textContent = 'Select';
      selectBtn.addEventListener('click', () => {
        sendToContent({ action: 'select_element', column: col.name });
        window.close();
      });

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-sm btn-remove-col';
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', async () => {
        const { chef_columns = [] } = await chrome.storage.local.get('chef_columns');
        const updated = chef_columns.filter(c => c.name !== col.name);
        await chrome.storage.local.set({ chef_columns: updated });
      });

      rowEl.append(dot, nameSpan, selSpan, countSpan, selectBtn, removeBtn);
      columnsContainer.appendChild(rowEl);
    }
  }

  async function renderNextBtnStatus() {
    const { chef_next_btn } = await chrome.storage.local.get('chef_next_btn');
    if (chef_next_btn) {
      nextBtnStatus.textContent = 'Ready';
      nextBtnStatus.className = 'status-text status-set';
    } else {
      nextBtnStatus.textContent = 'Not set';
      nextBtnStatus.className = 'status-text status-unset';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  DOCX BUILDER (Minimal Open XML in a ZIP)
  // ═══════════════════════════════════════════════════════════

  function buildDocx(columns, rows) {
    const esc = (s) => sanitize(String(s || 'N/A'))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const headerCells = columns.map(c =>
      `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F7D74A"/></w:tcPr>` +
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
      `<w:r><w:rPr><w:b/></w:rPr><w:t>${esc(c.name)}</w:t></w:r></w:p></w:tc>`
    ).join('');

    const dataRows = rows.map(row => {
      const cells = columns.map(c =>
        `<w:tc><w:p><w:r><w:t>${esc(row[c.name])}</w:t></w:r></w:p></w:tc>`
      ).join('');
      return `<w:tr>${cells}</w:tr>`;
    }).join('');

    const gridCols = columns.map(() => '<w:gridCol w:w="2400"/>').join('');

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Chef de Commis Export</w:t></w:r></w:p>
<w:tbl>
<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>
<w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>
</w:tblBorders></w:tblPr>
<w:tblGrid>${gridCols}</w:tblGrid>
<w:tr>${headerCells}</w:tr>
${dataRows}
</w:tbl>
</w:body>
</w:document>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    return createZip([
      { name: '[Content_Types].xml', data: contentTypesXml },
      { name: '_rels/.rels', data: relsXml },
      { name: 'word/document.xml', data: documentXml }
    ]);
  }

  // ─── Minimal ZIP Builder (store-only, no compression) ──────
  function createZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.data);
      const checksum = crc32(dataBytes);

      // Local file header (30 bytes + name)
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true); // store
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);

      // Central directory entry (46 bytes + name)
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);

      parts.push(lh, dataBytes);
      centralDir.push(cd);
      offset += lh.length + dataBytes.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const entry of centralDir) {
      parts.push(entry);
      cdSize += entry.length;
    }

    // End of central directory (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    parts.push(eocd);

    const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result.buffer;
  }

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════

  function sendToContent(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {
          alert('Content script not ready. Please refresh the page and try again.');
        });
      }
    });
  }

  function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename });
  }

  function csvEscape(val) {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
  }
});
