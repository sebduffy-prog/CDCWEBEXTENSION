document.addEventListener('DOMContentLoaded', async () => {
  const columnsContainer = document.getElementById('columns-container');
  const btnAddColumn = document.getElementById('btn-add-column');
  const inputNewColumn = document.getElementById('new-column-name');
  const btnAutoScroll = document.getElementById('btn-auto-scroll');
  const scrollCountInput = document.getElementById('target-count');
  const btnSelectNext = document.getElementById('btn-select-next');
  const btnAutoPaginate = document.getElementById('btn-auto-paginate');
  const pageCountInput = document.getElementById('page-count');
  const nextBtnStatus = document.getElementById('next-btn-status');
  const btnFormat = document.getElementById('btn-format');
  const btnDownloadTxt = document.getElementById('btn-download-txt');
  const btnDownloadCsv = document.getElementById('btn-download-csv');
  const btnDownloadDocx = document.getElementById('btn-download-docx');
  const btnClear = document.getElementById('btn-clear');
  const outputPreview = document.getElementById('output-preview');

  // Initialization
  await renderColumns();
  await updateNextBtnStatus();

  // -----------------------------------------
  // UI Actions
  // -----------------------------------------
  btnAddColumn.addEventListener('click', async () => {
    const name = inputNewColumn.value.trim();
    if (!name) return;
    const { chef_columns = [] } = await chrome.storage.local.get(['chef_columns']);
    if (!chef_columns.find(c => c.name === name)) {
      chef_columns.push({ name, cssSelector: null });
      await chrome.storage.local.set({ chef_columns });
      inputNewColumn.value = '';
      await renderColumns();
    }
  });

  btnSelectNext.addEventListener('click', async () => {
    sendMessageToContent({ action: 'select_next_btn' });
    window.close();
  });

  btnAutoScroll.addEventListener('click', () => {
    const scrolls = parseInt(scrollCountInput.value) || 5;
    sendMessageToContent({ action: 'auto_scroll', scrolls });
    window.close();
  });

  btnAutoPaginate.addEventListener('click', async () => {
    const pages = parseInt(pageCountInput.value) || 3;
    await chrome.storage.local.set({ is_paginating: true, pages_left: pages });
    sendMessageToContent({ action: 'scrape_and_paginate' });
    window.close();
  });

  btnClear.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    outputPreview.value = '';
    await renderColumns();
    await updateNextBtnStatus();
  });

  // --- Export: TXT ---
  btnDownloadTxt.addEventListener('click', () => {
    const data = outputPreview.value;
    if (!data) return alert("Nothing to download! Format data first.");
    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'Chef_de_Commis_Export.txt' });
  });

  // --- Export: CSV ---
  btnDownloadCsv.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (chef_columns.length === 0 || rows.length === 0) return alert("No data to export! Extract and format data first.");

    const escapeCsv = (val) => {
      const s = sanitize(String(val || 'N/A'));
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const header = chef_columns.map(c => escapeCsv(c.name)).join(',');
    const csvRows = rows.map(row =>
      chef_columns.map(c => escapeCsv(row[c.name])).join(',')
    );
    const csv = [header, ...csvRows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'Chef_de_Commis_Export.csv' });
  });

  // --- Export: DOCX ---
  btnDownloadDocx.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (chef_columns.length === 0 || rows.length === 0) return alert("No data to export! Extract and format data first.");

    const docx = buildDocx(chef_columns, rows);
    const blob = new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'Chef_de_Commis_Export.docx' });
  });

  // -----------------------------------------
  // The Data Formatting Pipeline
  // -----------------------------------------
  btnFormat.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    if (chef_columns.length === 0) return outputPreview.value = "No columns mapped.";

    const rows = Array.isArray(chef_data) ? chef_data : [];
    if (rows.length === 0) return outputPreview.value = "No data extracted yet.";

    let finalText = '';

    for (const row of rows) {
      for (const col of chef_columns) {
        const rawValue = row[col.name] || 'N/A';
        finalText += `${col.name}: ${sanitize(rawValue)}\n`;
      }
      finalText += '---\n';
    }

    outputPreview.value = finalText;
  });

  // Aggressive Noise & Chunk Sanitizer
  function sanitize(str) {
    if (!str || str === 'N/A') return 'N/A';
    
    let s = str.replace(/http[^\s]+/g, ''); // Strip URLs
    s = s.replace(/<[^>]*>?/gm, ''); // Strip HTML
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, ''); // Strip Zero Width Characters
    
    // Explicitly target YouTube/Social Media Noise
    s = s.replace(/^(Subscribe|Join|Reply|Share|Upvote|Save|Hide|Report)$/igm, ''); 
    s = s.replace(/\b(Subscribe|Join|Reply|Share|Upvote)\b/gi, '');
    s = s.replace(/^\s*\d+\s+(points|likes|comments|shares|views|months ago|years ago)\s*$/igm, '');
    
    // Massive Block Fix: Truncate run-on blocks (bad selectors)
    let lineBreaks = (s.match(/\n/g) || []).length;
    if (s.length > 500 && lineBreaks > 10) {
        // Flatten it to one line and truncate so it doesn't break row formatting
        s = s.replace(/\n+/g, ' ').substring(0, 500) + '... [TRUNCATED NOISE BLOCK]';
    } else {
        s = s.replace(/\n{3,}/g, '\n\n'); // Normalize spacing
    }
    
    return s.trim() || 'N/A';
  }

  // -----------------------------------------
  // DOCX Builder (minimal Open XML in a ZIP)
  // -----------------------------------------
  function buildDocx(columns, rows) {
    // Escape XML special characters
    const esc = (s) => sanitize(String(s || 'N/A')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Build table rows XML
    const headerCells = columns.map(c =>
      `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F7D74A"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(c.name)}</w:t></w:r></w:p></w:tc>`
    ).join('');
    const headerRow = `<w:tr>${headerCells}</w:tr>`;

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
${headerRow}
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

    // Build ZIP manually (minimal spec-compliant ZIP for DOCX)
    return createZip([
      { name: '[Content_Types].xml', data: contentTypesXml },
      { name: '_rels/.rels', data: relsXml },
      { name: 'word/document.xml', data: documentXml }
    ]);
  }

  // Minimal ZIP file builder (no compression, store-only)
  function createZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.data);

      // Local file header
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lhView = new DataView(localHeader.buffer);
      lhView.setUint32(0, 0x04034b50, true); // signature
      lhView.setUint16(4, 20, true); // version needed
      lhView.setUint16(6, 0, true); // flags
      lhView.setUint16(8, 0, true); // compression (store)
      lhView.setUint16(10, 0, true); // mod time
      lhView.setUint16(12, 0, true); // mod date
      lhView.setUint32(14, crc32(dataBytes), true); // crc32
      lhView.setUint32(18, dataBytes.length, true); // compressed size
      lhView.setUint32(22, dataBytes.length, true); // uncompressed size
      lhView.setUint16(26, nameBytes.length, true); // filename length
      lhView.setUint16(28, 0, true); // extra field length
      localHeader.set(nameBytes, 30);

      // Central directory entry
      const cdEntry = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdEntry.buffer);
      cdView.setUint32(0, 0x02014b50, true); // signature
      cdView.setUint16(4, 20, true); // version made by
      cdView.setUint16(6, 20, true); // version needed
      cdView.setUint16(8, 0, true); // flags
      cdView.setUint16(10, 0, true); // compression
      cdView.setUint16(12, 0, true); // mod time
      cdView.setUint16(14, 0, true); // mod date
      cdView.setUint32(16, crc32(dataBytes), true); // crc32
      cdView.setUint32(20, dataBytes.length, true); // compressed
      cdView.setUint32(24, dataBytes.length, true); // uncompressed
      cdView.setUint16(28, nameBytes.length, true); // filename length
      cdView.setUint16(30, 0, true); // extra length
      cdView.setUint16(32, 0, true); // comment length
      cdView.setUint16(34, 0, true); // disk number
      cdView.setUint16(36, 0, true); // internal attrs
      cdView.setUint32(38, 0, true); // external attrs
      cdView.setUint32(42, offset, true); // local header offset
      cdEntry.set(nameBytes, 46);

      parts.push(localHeader, dataBytes);
      centralDir.push(cdEntry);
      offset += localHeader.length + dataBytes.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const entry of centralDir) {
      parts.push(entry);
      cdSize += entry.length;
    }

    // End of central directory
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true); // signature
    eocdView.setUint16(4, 0, true); // disk number
    eocdView.setUint16(6, 0, true); // cd disk number
    eocdView.setUint16(8, files.length, true); // entries on disk
    eocdView.setUint16(10, files.length, true); // total entries
    eocdView.setUint32(12, cdSize, true); // cd size
    eocdView.setUint32(16, cdOffset, true); // cd offset
    eocdView.setUint16(20, 0, true); // comment length
    parts.push(eocd);

    // Combine all parts
    const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result.buffer;
  }

  // CRC32 implementation for ZIP
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

  // -----------------------------------------
  // Helpers
  // -----------------------------------------
  async function renderColumns() {
    const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    const rows = Array.isArray(chef_data) ? chef_data : [];
    columnsContainer.innerHTML = '';

    chef_columns.forEach(col => {
      const count = rows.filter(r => r[col.name] && r[col.name] !== 'N/A').length;
      const isMapped = col.cssSelector && count > 0;
      const row = document.createElement('div');
      row.className = 'column-row';
      row.innerHTML = `
        <span class="status-dot ${isMapped ? 'status-mapped' : 'status-unmapped'}"></span>
        <span class="col-name">${col.name}</span>
        <span class="col-count">${count} items</span>
        <button class="btn-select btn-sm btn-select-col" data-col="${col.name}">Select</button>
        <button class="btn-remove btn-sm btn-remove-col" data-col="${col.name}">&times;</button>
      `;
      columnsContainer.appendChild(row);
    });

    document.querySelectorAll('.btn-select').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const colName = e.target.getAttribute('data-col');
        sendMessageToContent({ action: 'select_element', column: colName });
        window.close();
      });
    });

    document.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const colName = e.target.getAttribute('data-col');
        const { chef_columns = [] } = await chrome.storage.local.get(['chef_columns']);
        const updated = chef_columns.filter(c => c.name !== colName);
        await chrome.storage.local.set({ chef_columns: updated });
        await renderColumns();
      });
    });
  }

  async function updateNextBtnStatus() {
    const { chef_next_btn } = await chrome.storage.local.get(['chef_next_btn']);
    if (chef_next_btn) {
      nextBtnStatus.textContent = 'Ready';
      nextBtnStatus.className = 'status-text status-set';
    } else {
      nextBtnStatus.textContent = 'Not set';
      nextBtnStatus.className = 'status-text status-unset';
    }
  }

  function sendMessageToContent(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message).catch(err => {
          console.error("Content script not ready:", err);
          alert("Please refresh the webpage and try again.");
        });
      }
    });
  }
});
