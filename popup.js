document.addEventListener('DOMContentLoaded', async () => {
  const columnsContainer = document.getElementById('columns-container');
  const btnAddColumn = document.getElementById('btn-add-column');
  const inputNewColumn = document.getElementById('new-column-name');
  const btnAutoScroll = document.getElementById('btn-auto-scroll');
  const scrollCountInput = document.getElementById('scroll-count');
  const btnSelectNext = document.getElementById('btn-select-next');
  const btnAutoPaginate = document.getElementById('btn-auto-paginate');
  const pageCountInput = document.getElementById('page-count');
  const nextBtnStatus = document.getElementById('next-btn-status');
  const btnFormat = document.getElementById('btn-format');
  const btnDownload = document.getElementById('btn-download');
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

  btnDownload.addEventListener('click', () => {
    const data = outputPreview.value;
    if (!data) return alert("Nothing to download! Format data first.");
    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url: url, filename: 'Chef_de_Commis_Export.txt' });
  });

  // -----------------------------------------
  // The Data Formatting Pipeline
  // -----------------------------------------
  btnFormat.addEventListener('click', async () => {
    const { chef_columns = [], chef_data = {} } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    if (chef_columns.length === 0) return outputPreview.value = "No columns mapped.";

    // Determine row count by finding the longest array
    let maxRows = 0;
    for (const key in chef_data) {
      if (chef_data[key].length > maxRows) maxRows = chef_data[key].length;
    }

    let finalText = '';

    for (let i = 0; i < maxRows; i++) {
      chef_columns.forEach(col => {
        let rawValue = (chef_data[col.name] && chef_data[col.name][i]) ? chef_data[col.name][i] : 'N/A';
        finalText += `${col.name}: ${sanitize(rawValue)}\n`;
      });
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
  // Helpers
  // -----------------------------------------
  async function renderColumns() {
    const { chef_columns = [], chef_data = {} } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
    columnsContainer.innerHTML = '';
    
    chef_columns.forEach(col => {
      const count = (chef_data[col.name] || []).length;
      const row = document.createElement('div');
      row.className = 'column-row';
      row.innerHTML = `
        <div class="flex flex-col flex-1 overflow-hidden">
          <span class="col-name">${col.name}</span>
          <span class="col-count">${count} items saved</span>
        </div>
        <button class="btn-select btn-outline text-[10px] px-2 py-1 rounded" data-col="${col.name}">Select</button>
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
  }

  async function updateNextBtnStatus() {
    const { chef_next_btn } = await chrome.storage.local.get(['chef_next_btn']);
    if (chef_next_btn) {
      nextBtnStatus.textContent = 'Ready';
      nextBtnStatus.className = 'text-green-500 text-xs font-bold';
    } else {
      nextBtnStatus.textContent = 'Not set';
      nextBtnStatus.className = 'text-zinc-500 text-xs italic';
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
