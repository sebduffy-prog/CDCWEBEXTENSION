// Global State
let isSelecting = false;
let targetColumn = '';
let isPaginating = false;

// The Event Fortress (Blocks YouTube/Instagram from hijacking clicks)
const eventsToBlock = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];

function blockEvent(e) {
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
  
  document.addEventListener('mouseover', onMouseOver, { capture: true });
  document.addEventListener('mouseout', onMouseOut, { capture: true });
  eventsToBlock.forEach(ev => document.addEventListener(ev, onClick, { capture: true }));
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

async function onClick(e) {
  blockEvent(e);
  if (e.type !== 'click') return; // Only process the actual click
  
  isSelecting = false;
  document.removeEventListener('mouseover', onMouseOver, { capture: true });
  document.removeEventListener('mouseout', onMouseOut, { capture: true });
  
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
    
    // Immediately extract to update counts
    await extractAllColumns('overwrite');
    showToast(`Mapped: ${targetColumn}`);
  }
  
  // Remove event blockers after a short delay
  setTimeout(() => {
    eventsToBlock.forEach(ev => document.removeEventListener(ev, blockEvent, { capture: true }));
    eventsToBlock.forEach(ev => document.removeEventListener(ev, onClick, { capture: true }));
  }, 300);
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
// Data Extraction & Sync Engine
// ---------------------------------------------
async function extractAllColumns(mode = 'overwrite') {
  // Smart Wait: Give lazy-loaded text time to render
  await new Promise(resolve => setTimeout(resolve, 500)); 
  
  const { chef_columns = [], chef_data = {} } = await chrome.storage.local.get(['chef_columns', 'chef_data']);
  if (chef_columns.length === 0) return;

  if (mode === 'overwrite') {
    for (const col of chef_columns) chef_data[col.name] = [];
  }

  for (const col of chef_columns) {
    if (!col.cssSelector) continue;
    
    let els = Array.from(document.querySelectorAll(col.cssSelector));
    
    // Fuzzy Fallback: If 0 items found, try searching by the last class name
    if (els.length === 0) {
        const parts = col.cssSelector.split('.');
        if (parts.length > 1) {
            const fuzzyClass = parts[parts.length - 1];
            els = Array.from(document.querySelectorAll(`[class*="${fuzzyClass}"]`));
        }
    }

    const newValues = els.map(el => el.innerText.trim()).filter(text => text.length > 0);
    
    if (mode === 'append') {
      const currentSet = new Set(chef_data[col.name] || []);
      newValues.forEach(val => {
        if (!currentSet.has(val)) {
          if (!chef_data[col.name]) chef_data[col.name] = [];
          chef_data[col.name].push(val);
        }
      });
    } else {
      chef_data[col.name] = newValues;
    }
  }
  
  await chrome.storage.local.set({ chef_data });
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
