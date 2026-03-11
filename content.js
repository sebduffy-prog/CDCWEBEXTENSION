// Global State
let isSelecting = false;
let targetColumn = '';
let isPaginating = false;

// ---------------------------------------------
// Event Suppression (prevents page navigation during selection)
// ---------------------------------------------

// Capture-phase blockers for click and mouseup.
// These remain active briefly AFTER selection completes so the browser
// does not follow links or fire handlers from the pointer-down event.
function suppressClick(e) {
  if (isSelecting) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}

function suppressMouseUp(e) {
  if (isSelecting) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}

// ---------------------------------------------
// Message Listener
// ---------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'select_element') {
    startSelectionMode(request.column);
    sendResponse({ status: 'Selection mode activated' });
  } else if (request.action === 'select_next_btn') {
    startSelectionMode('next_btn');
    sendResponse({ status: 'Next button selection activated' });
  } else if (request.action === 'auto_scroll') {
    performAutoScroll(request.scrolls);
    sendResponse({ status: 'Scrolling started' });
  } else if (request.action === 'scrape_and_paginate') {
    startPagination();
    sendResponse({ status: 'Pagination started' });
  }
  return true;
});

// ---------------------------------------------
// Visual Scraper Logic
// ---------------------------------------------
function startSelectionMode(columnName) {
  isSelecting = true;
  targetColumn = columnName;

  // Inject Hover CSS
  let style = document.getElementById('chef-de-commis-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'chef-de-commis-style';
    style.textContent = `
      .chef-hover {
        outline: 3px solid #f7d74a !important;
        cursor: crosshair !important;
        background-color: rgba(247, 215, 74, 0.15) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Hover listeners
  document.addEventListener('mouseover', onMouseOver, { capture: true });
  document.addEventListener('mouseout', onMouseOut, { capture: true });

  // FIX #1: Selection fires on pointerdown (not click), so the browser
  // can never swallow the event before we act on it.
  document.addEventListener('pointerdown', onPointerDown, { capture: true });

  // Block click and mouseup in capture phase so the page cannot navigate.
  document.addEventListener('click', suppressClick, { capture: true });
  document.addEventListener('mouseup', suppressMouseUp, { capture: true });
}

function onMouseOver(e) {
  if (isSelecting && e.target) {
    e.target.classList.add('chef-hover');
  }
}

function onMouseOut(e) {
  if (isSelecting && e.target) {
    e.target.classList.remove('chef-hover');
  }
}

// FIX #1: The selection trigger now lives on pointerdown.
async function onPointerDown(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  // End selection mode immediately
  isSelecting = false;

  // Remove hover listeners
  document.removeEventListener('mouseover', onMouseOver, { capture: true });
  document.removeEventListener('mouseout', onMouseOut, { capture: true });
  document.removeEventListener('pointerdown', onPointerDown, { capture: true });

  // Remove hover highlight from the clicked element
  if (e.target) e.target.classList.remove('chef-hover');

  const selector = computeSelector(e.target);

  if (targetColumn === 'next_btn') {
    await chrome.storage.local.set({ chef_next_btn: selector });
    showToast('Next Button Saved!');
  } else {
    const { chef_columns = [] } = await chrome.storage.local.get(['chef_columns']);
    const existingCol = chef_columns.find(c => c.name === targetColumn);
    if (existingCol) {
      existingCol.cssSelector = selector;
    } else {
      chef_columns.push({ name: targetColumn, cssSelector: selector });
    }
    await chrome.storage.local.set({ chef_columns });

    // Immediately extract to update counts — only overwrite the target column
    await extractAllColumns('overwrite', targetColumn);
    showToast(`Mapped: ${targetColumn}`);
  }

  // Keep click/mouseup blockers alive for 500ms so the browser cannot
  // follow a link from the tail-end of this pointer interaction.
  setTimeout(() => {
    document.removeEventListener('click', suppressClick, { capture: true });
    document.removeEventListener('mouseup', suppressMouseUp, { capture: true });
  }, 500);
}

// Stricter Selector Math to prevent grabbing entire page blocks
function computeSelector(el) {
  if (!el) return '';
  let path = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'body') {
    let tag = current.tagName.toLowerCase();

    if (current.id) {
      path.unshift(`${tag}#${current.id}`);
      break; // IDs are unique, we can stop here
    } else if (current.className && typeof current.className === 'string') {
      let classes = current.className.split(/\s+/).filter(c => c && !c.includes('hover') && !c.includes('active') && !c.includes('style'));
      if (classes.length > 0) {
        path.unshift(`${tag}.${classes.join('.')}`);
      } else {
        path.unshift(tag);
      }
    } else {
      path.unshift(tag);
    }

    current = current.parentElement;
    if (path.length >= 3) break; // Limit depth so it finds similar siblings
  }
  return path.join(' > ');
}

// ---------------------------------------------
// Container-Based Extraction Engine
// ---------------------------------------------

// Find the closest common ancestor DOM element that wraps all mapped selectors.
// Returns a CSS selector string for that container, or null if none found.
function computeCommonContainer(activeCols) {
  // Get first matched element for each column
  const firstElements = activeCols.map(col => document.querySelector(col.cssSelector));
  if (firstElements.some(el => !el)) return null;

  // Build ancestor chains (parent -> grandparent -> ... -> body)
  const chains = firstElements.map(el => {
    const chain = [];
    let cur = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    return chain;
  });

  // Walk up from the first element's parent; find the shallowest ancestor
  // that is shared by ALL column elements (lowest common ancestor)
  for (const ancestor of chains[0]) {
    if (chains.every(chain => chain.includes(ancestor))) {
      const selector = buildContainerSelector(ancestor);
      // Sanity: the selector must match more than one container on the page
      const matches = document.querySelectorAll(selector);
      if (matches.length >= 2) return selector;
      // If only 1 match, try the next ancestor up
    }
  }
  return null;
}

// Build a reusable CSS selector for a container element (tag + classes).
function buildContainerSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.split(/\s+/).filter(c =>
      c && !c.includes('hover') && !c.includes('active') && !c.includes('chef'));
    if (classes.length > 0) return `${tag}.${classes.join('.')}`;
  }
  // Fallback: use parent context for specificity
  if (el.parentElement && el.parentElement !== document.body) {
    const parentTag = el.parentElement.tagName.toLowerCase();
    if (el.parentElement.className && typeof el.parentElement.className === 'string') {
      const pClasses = el.parentElement.className.split(/\s+/).filter(c => c);
      if (pClasses.length > 0) return `${parentTag}.${pClasses.join('.')} > ${tag}`;
    }
    return `${parentTag} > ${tag}`;
  }
  return tag;
}

// Search for a column's element within a specific container.
// Tries progressively shorter selector suffixes, then a fuzzy class fallback.
function queryWithinContainer(container, fullSelector) {
  // Try the full selector (works if the selector is entirely within the container)
  let el = container.querySelector(fullSelector);
  if (el) return el;

  // Try removing leading segments one at a time (handles cases where
  // the selector includes the container element itself as a prefix)
  const parts = fullSelector.split(/\s*>\s*/);
  for (let i = 1; i < parts.length; i++) {
    el = container.querySelector(parts.slice(i).join(' > '));
    if (el) return el;
  }

  // Also try with descendant combinator splits
  const spaceParts = fullSelector.split(/\s+/);
  for (let i = 1; i < spaceParts.length; i++) {
    el = container.querySelector(spaceParts.slice(i).join(' '));
    if (el) return el;
  }

  // Fuzzy fallback: match by the last class in the selector
  const classParts = fullSelector.split('.');
  if (classParts.length > 1) {
    const fuzzyClass = classParts[classParts.length - 1].split(/[\s>[\]]/)[0];
    if (fuzzyClass) el = container.querySelector(`[class*="${fuzzyClass}"]`);
    if (el) return el;
  }

  return null;
}

// FIX #2 & #3: extractAllColumns now accepts targetColName so it only
// resets the specified column (not all), and no longer filters out empty strings.
async function extractAllColumns(mode = 'overwrite', targetColName = null) {
  // Smart Wait: Give lazy-loaded text time to render
  await new Promise(resolve => setTimeout(resolve, 500));

  const { chef_columns = [], chef_data = [] } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
  if (chef_columns.length === 0) return;

  const activeCols = chef_columns.filter(c => c.cssSelector);
  if (activeCols.length === 0) return;

  let newRows = [];

  // --- Container-Based Extraction ---
  const containerSelector = activeCols.length >= 2
    ? computeCommonContainer(activeCols)
    : null;

  if (containerSelector) {
    const containers = document.querySelectorAll(containerSelector);
    for (const container of containers) {
      const row = {};
      for (const col of chef_columns) {
        if (!col.cssSelector) { row[col.name] = 'N/A'; continue; }
        const el = queryWithinContainer(container, col.cssSelector);
        const text = el ? el.innerText.trim() : '';
        row[col.name] = text || 'N/A';
      }
      newRows.push(row);
    }
  } else {
    // Fallback: single column or no common container found.
    // Query each column independently but still output Array of Objects.
    const columnArrays = {};
    let maxLen = 0;
    for (const col of activeCols) {
      let els = Array.from(document.querySelectorAll(col.cssSelector));
      // Fuzzy Fallback
      if (els.length === 0) {
        const parts = col.cssSelector.split('.');
        if (parts.length > 1) {
          const fuzzyClass = parts[parts.length - 1];
          els = Array.from(document.querySelectorAll(`[class*="${fuzzyClass}"]`));
        }
      }
      // FIX #3: Do NOT filter out empty strings — keep them so arrays
      // stay aligned across columns when zipped together for export.
      columnArrays[col.name] = els.map(el => {
        const text = el.innerText.trim();
        return text || 'N/A';
      });
      maxLen = Math.max(maxLen, columnArrays[col.name].length);
    }
    for (let i = 0; i < maxLen; i++) {
      const row = {};
      for (const col of chef_columns) {
        row[col.name] = (columnArrays[col.name] && columnArrays[col.name][i]) || 'N/A';
      }
      newRows.push(row);
    }
  }

  // --- Storage: overwrite or append with deduplication ---
  let finalData;
  if (mode === 'overwrite') {
    if (targetColName && Array.isArray(chef_data) && chef_data.length > 0) {
      // FIX #2: Only overwrite the targeted column's values.
      // Preserve all other columns' data in the existing rows.
      finalData = [];
      const maxLen = Math.max(chef_data.length, newRows.length);
      for (let i = 0; i < maxLen; i++) {
        const existingRow = chef_data[i] || {};
        const newRow = newRows[i] || {};
        // Start from existing data, then overwrite only the target column
        const merged = { ...existingRow };
        merged[targetColName] = newRow[targetColName] || 'N/A';
        // If the new row has columns not yet in existing data (first-time
        // columns), add those too
        for (const key of Object.keys(newRow)) {
          if (!(key in merged)) {
            merged[key] = newRow[key];
          }
        }
        finalData.push(merged);
      }
    } else {
      finalData = newRows;
    }
  } else {
    const existing = Array.isArray(chef_data) ? chef_data : [];
    const existingKeys = new Set(existing.map(r => JSON.stringify(r)));
    const uniqueNew = newRows.filter(r => !existingKeys.has(JSON.stringify(r)));
    finalData = [...existing, ...uniqueNew];
  }

  await chrome.storage.local.set({ chef_data: finalData });
}

// ---------------------------------------------
// Automation Math
// ---------------------------------------------
async function performAutoScroll(scrolls) {
  for (let i = 0; i < scrolls; i++) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    setTimeout(() => window.scrollTo(0, document.documentElement.scrollHeight), 50);

    await new Promise(r => setTimeout(r, 800)); // Wait for network
    await extractAllColumns('append'); // Extract on every tick
    showToast(`Scrolling... ${i + 1}/${scrolls}`);
  }
  showToast('Auto-Scroll Complete!');
}

async function startPagination() {
  const { is_paginating, pages_left, chef_next_btn } = await chrome.storage.local.get(['is_paginating', 'pages_left', 'chef_next_btn']);

  if (is_paginating && pages_left > 0) {
    await extractAllColumns('append');
    await chrome.storage.local.set({ pages_left: pages_left - 1 });

    if (pages_left - 1 > 0 && chef_next_btn) {
      const nextBtn = document.querySelector(chef_next_btn);
      if (nextBtn) {
        showToast('Loading next page...');
        nextBtn.click();
      } else {
        showToast('Next button not found. Stopping.');
        await chrome.storage.local.set({ is_paginating: false });
      }
    } else {
      showToast('Pagination Complete!');
      await chrome.storage.local.set({ is_paginating: false });
    }
  }
}

// Check pagination on page load
window.addEventListener('load', async () => {
  const { is_paginating } = await chrome.storage.local.get(['is_paginating']);
  if (is_paginating) {
    setTimeout(startPagination, 2000); // Give DOM 2 seconds to settle
  }
});

// Toast UI
function showToast(message) {
  let toast = document.getElementById('chef-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'chef-toast';
    toast.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:#f7d74a; color:#09090b; padding:8px 16px; border-radius:4px; font-weight:bold; z-index:999999; font-family:sans-serif; box-shadow:0 4px 6px rgba(0,0,0,0.3); transition: opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}
