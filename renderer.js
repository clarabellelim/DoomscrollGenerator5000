'use strict';

// =============================================
// STATE
// =============================================
const state = {
  results: [],       // all { info, analysis, status } objects (shared across tabs)
  running: false,    // single analysis in progress
  bulkRunning: false,
  headlessEnabled: false, // reflects "show browser" toggle (headless = false means show)
};

// =============================================
// TOAST NOTIFICATIONS
// =============================================
function toast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// =============================================
// STATUS BAR
// =============================================
function setStatus(id, message, type = 'info', spinner = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = spinner
    ? `<span class="spinner"></span>${message}`
    : message;
  el.className = `status-bar ${type}`;
}
function clearStatus(id) {
  const el = document.getElementById(id);
  if (el) el.className = 'status-bar';
}

// =============================================
// TAB SWITCHING
// =============================================
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

// =============================================
// PLATFORM BADGE HTML
// =============================================
function platformBadge(platform) {
  const labels = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
  const icons  = { tiktok: '♪', instagram: '📷', youtube: '▶' };
  const label  = labels[platform] || platform;
  const icon   = icons[platform]  || '';
  return `<span class="platform-badge ${platform}"><span class="badge-icon">${icon}</span><span>${label}</span></span>`;
}

// =============================================
// TABLE RENDERING
// =============================================
function renderRow(result, index, tbodyId) {
  const { info, analysis, status } = result;
  const tbody = document.getElementById(tbodyId);
  const emptyId = tbodyId === 'results-body' ? 'empty-row' : 'bulk-empty-row';
  const emptyRow = document.getElementById(emptyId);
  if (emptyRow) emptyRow.remove();

  const viralPreview =
    analysis?.viral
      ? analysis.viral.replace(/\n/g, ' ').substring(0, 120) + '…'
      : status === 'failed' ? '⚠ Analysis failed' : '—';

  const captionText = (info.caption || '-')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

  const tr = document.createElement('tr');
  tr.dataset.index = index;

  tr.innerHTML = `
    <td class="td-num">${index + 1}</td>
    <td class="td-platform">${platformBadge(info.platform)}</td>
    <td style="font-weight:600;font-size:13px">${escHtml(info.creator)}</td>
    <td class="td-engagement">${escHtml(info.likes)}</td>
    <td class="td-engagement">${escHtml(info.comments)}</td>
    <td class="td-engagement" title="${escHtml(info.sharesLabel || 'Shares')}">${escHtml(info.shares)}</td>
    <td style="white-space:nowrap;color:var(--muted)">${escHtml(info.duration)}</td>
    <td class="td-caption">
      <div class="caption-text" title="${captionText}">${escHtml(info.caption || '-')}</div>
    </td>
    <td class="td-analysis">
      <div class="analysis-preview">${escHtml(viralPreview)}</div>
    </td>
    <td class="td-actions">
      ${analysis ? `<button class="btn-view" onclick="openDetail(${index})">View</button>` : ''}
      <button class="btn-link" onclick="openLink('${escAttr(info.url)}')" title="Open video">↗</button>
    </td>
  `;

  tbody.appendChild(tr);
}

function escHtml(str) {
  if (!str) return '-';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str || '').replace(/'/g, "\\'");
}

// =============================================
// WELCOME SLIDER OVERLAY
// =============================================
(function initWelcomeOverlay() {
  const overlay = document.getElementById('welcome-overlay');
  const slider  = document.getElementById('welcome-slider');
  const thumb   = document.getElementById('welcome-slider-thumb');
  const label   = document.getElementById('welcome-slider-text');
  if (!overlay || !slider || !thumb) return;

  slider.value = 0;
  let completed = false;

  const complete = () => {
    if (completed) return;
    completed = true;
    thumb.classList.add('done');
    if (label) label.textContent = 'Welcome, fellow doomscroller 🩷';
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 350);
  };

  slider.addEventListener('input', () => {
    const v = Number(slider.value || 0);
    const clamped = Math.max(0, Math.min(100, v));
    const trackWidth = slider.getBoundingClientRect().width || 1;
    const inset = 42; // leave room for left/right padding
    const maxX = trackWidth - inset;
    const minX = 0;
    const x = minX + (maxX - minX) * (clamped / 100);
    thumb.style.transform = `translateX(${x}px)`;
    if (label && !completed) {
      label.textContent = clamped >= 96 ? 'Release to enter' : 'Slide all the way to enter';
    }
    if (clamped >= 98) complete();
  });
})();

function updateResultCounts() {
  const single = document.getElementById('result-count');
  const bulk   = document.getElementById('bulk-result-count');
  if (single) single.textContent = state.results.length;
  if (bulk)   bulk.textContent   = state.results.length;

  const hasResults = state.results.length > 0;
  ['btn-copy','btn-pdf','btn-excel','btn-bulk-copy','btn-bulk-pdf','btn-bulk-excel'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !hasResults;
  });
}

function openLink(url) {
  window.api.openExternal(url);
}

// =============================================
// SINGLE VIDEO ANALYSIS
// =============================================
document.getElementById('btn-single-analyze').addEventListener('click', startSingle);
document.getElementById('single-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startSingle();
});

async function startSingle() {
  if (state.running || state.bulkRunning) return;
  const url = document.getElementById('single-url').value.trim();
  if (!url) { toast('Please enter a URL', 'error'); return; }

  state.running = true;
  const btn = document.getElementById('btn-single-analyze');
  btn.disabled = true;
  setStatus('single-status', 'Launching browser and fetching video data…', 'info', true);

  try {
    const res = await window.api.analyzeSingle(url);

    if (!res.success) {
      setStatus('single-status', res.error, 'error');
      toast(res.error, 'error', 5000);
      return;
    }

    clearStatus('single-status');
    const index = state.results.length;
    state.results.push(res);

    // Add to BOTH tables so result is visible in both tabs
    renderRow(res, index, 'results-body');
    renderRow(res, index, 'bulk-results-body');
    updateResultCounts();

    document.getElementById('single-url').value = '';
    toast('Analysis complete!', 'success');
  } catch (e) {
    setStatus('single-status', `Unexpected error: ${e.message}`, 'error');
    toast(e.message, 'error', 5000);
  } finally {
    state.running = false;
    btn.disabled = false;
  }
}

// =============================================
// BULK ANALYSIS
// =============================================
document.getElementById('btn-bulk-start').addEventListener('click', startBulk);
document.getElementById('btn-bulk-stop').addEventListener('click', stopBulk);
document.getElementById('bulk-keyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startBulk();
});

// Platform checkbox toggles
// e.preventDefault() is required: without it the browser also clicks the
// inner <input> (default label behaviour), causing a double-toggle that
// leaves the visual and actual state out of sync.
document.querySelectorAll('.platform-check').forEach((label) => {
  label.addEventListener('click', (e) => {
    e.preventDefault();
    const cb = label.querySelector('input');
    cb.checked = !cb.checked;
    label.classList.toggle('checked', cb.checked);
  });
});

// =============================================
// EDITABLE LIKES FILTER
// =============================================
const DEFAULT_FILTER_THRESHOLDS = [10000, 5000, 1000];
let filterThresholds = [...DEFAULT_FILTER_THRESHOLDS];

function renderFilterTiers() {
  const container = document.getElementById('filter-tiers');
  container.innerHTML = filterThresholds.map((val, i) => `
    <div class="filter-tier">
      <input class="tier-input" type="number" value="${val}" min="0" step="1000"
             data-idx="${i}" title="Tier ${i + 1} minimum likes" />
      <span class="tier-plus">+</span>
      <button class="tier-del" data-idx="${i}" title="Remove tier">×</button>
    </div>
    ${i < filterThresholds.length - 1 ? '<span class="tier-arrow">→</span>' : ''}
  `).join('');

  container.querySelectorAll('.tier-input').forEach((input) => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      filterThresholds[idx] = Math.max(0, parseInt(input.value) || 0);
    });
  });

  container.querySelectorAll('.tier-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      filterThresholds.splice(idx, 1);
      renderFilterTiers();
    });
  });
}

document.getElementById('btn-add-tier').addEventListener('click', () => {
  // Default new tier to half of the smallest existing tier, minimum 500
  const smallest = filterThresholds.length ? Math.min(...filterThresholds) : 1000;
  filterThresholds.push(Math.max(500, Math.round(smallest / 2 / 500) * 500));
  renderFilterTiers();
});

document.getElementById('btn-reset-filter').addEventListener('click', () => {
  filterThresholds = [...DEFAULT_FILTER_THRESHOLDS];
  renderFilterTiers();
});

// Initial render
renderFilterTiers();

document.getElementById('btn-clear-log').addEventListener('click', () => {
  document.getElementById('progress-log').innerHTML = '';
});

async function startBulk() {
  if (state.running || state.bulkRunning) return;

  const keyword   = document.getElementById('bulk-keyword').value.trim();
  const limit     = parseInt(document.getElementById('bulk-limit').value) || 10;
  const platforms = Array.from(document.querySelectorAll('.platform-check input:checked'))
    .map((cb) => cb.value);

  if (!keyword)            { toast('Please enter a keyword', 'error'); return; }
  if (platforms.length === 0) { toast('Select at least one platform', 'error'); return; }

  state.bulkRunning = true;
  const btn = document.getElementById('btn-bulk-start');
  const stopBtn = document.getElementById('btn-bulk-stop');
  btn.disabled = true;
  btn.style.display = 'none';
  stopBtn.style.display = '';

  // Show progress pane
  const wrapper = document.getElementById('progress-wrapper');
  wrapper.classList.add('visible');
  const logEl = document.getElementById('progress-log');
  logEl.innerHTML = '';

  setStatus('bulk-status', `Running bulk analysis for "${keyword}"…`, 'info', true);

  // Register progress listener
  window.api.offBulkProgress();
  window.api.onBulkProgress((data) => {
    switch (data.type) {
      case 'header':
        appendLog(`\n▶ ${data.message}`, 'header');
        break;
      case 'log':
        appendLog(data.message, data.level || 'default');
        break;
      case 'result': {
        const idx = state.results.length;
        state.results.push(data.result);
        renderRow(data.result, idx, 'results-body');
        renderRow(data.result, idx, 'bulk-results-body');
        updateResultCounts();
        break;
      }
      case 'complete':
        clearStatus('bulk-status');
        setStatus(
          'bulk-status',
          `Bulk analysis complete — ${data.totalCount} video(s) analysed`,
          'success'
        );
        appendLog(`\n✓ Complete: ${data.totalCount} video(s) analysed`, 'success');
        toast(`Bulk analysis done! ${data.totalCount} videos analysed.`, 'success', 5000);
        finishBulkUI();
        break;
      case 'stopped':
        clearStatus('bulk-status');
        setStatus(
          'bulk-status',
          `Stopped — ${data.totalCount} video(s) analysed so far`,
          'warn'
        );
        appendLog(`\n⏹ Stopped by user. ${data.totalCount} video(s) analysed.`, 'warn');
        toast(`Analysis stopped. ${data.totalCount} video(s) saved.`, 'warn', 5000);
        finishBulkUI();
        break;
      case 'error':
        setStatus('bulk-status', `Error: ${data.message}`, 'error');
        appendLog(`✗ ${data.message}`, 'error');
        toast(`Error: ${data.message}`, 'error', 6000);
        break;
    }
  });

  // Collect current thresholds from the editable filter; always append 0 (any)
  const thresholds = [...filterThresholds.map(v => Math.max(0, parseInt(v) || 0)), 0];

  try {
    await window.api.analyzeBulk(keyword, platforms, limit, thresholds);
  } catch (e) {
    setStatus('bulk-status', `Unexpected error: ${e.message}`, 'error');
    toast(e.message, 'error', 6000);
    finishBulkUI();
  }
}

function finishBulkUI() {
  window.api.offBulkProgress();
  state.bulkRunning = false;
  const startBtn = document.getElementById('btn-bulk-start');
  const stopBtn  = document.getElementById('btn-bulk-stop');
  startBtn.disabled = false;
  startBtn.style.display = '';
  stopBtn.style.display = 'none';
  stopBtn.disabled = false;
  stopBtn.textContent = '⏹ Stop';
}

async function stopBulk() {
  if (!state.bulkRunning) return;
  document.getElementById('btn-bulk-stop').disabled = true;
  document.getElementById('btn-bulk-stop').textContent = 'Stopping…';
  await window.api.stopBulk();
}

function appendLog(message, level = 'default') {
  const logEl = document.getElementById('progress-log');
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// =============================================
// DETAIL MODAL
// =============================================
window.openDetail = function (index) {
  const result = state.results[index];
  if (!result || !result.analysis) return;

  const { info, analysis } = result;

  // Title
  document.getElementById('modal-title').textContent =
    `${info.platform.charAt(0).toUpperCase() + info.platform.slice(1)} — ${info.creator}`;

  // Info chips
  const infoRow = document.getElementById('modal-info-row');
  infoRow.innerHTML = [
    ['Platform', info.platform.charAt(0).toUpperCase() + info.platform.slice(1)],
    ['Creator', info.creator],
    ['Likes', info.likes],
    ['Comments', info.comments],
    [info.sharesLabel || 'Shares', info.shares],
    ['Duration', info.duration],
  ]
    .map(
      ([label, val]) =>
        `<div class="info-chip"><span class="label">${label}</span><span class="val">${escHtml(val)}</span></div>`
    )
    .join('');

  // URL link
  const urlLink = document.createElement('a');
  urlLink.className = 'url-link';
  urlLink.textContent = '↗ Open Video';
  urlLink.addEventListener('click', () => window.api.openExternal(info.url));
  infoRow.appendChild(urlLink);

  // Analysis text
  document.getElementById('modal-viral-text').textContent = analysis.viral || '—';
  document.getElementById('modal-lens-text').textContent  = analysis.lens  || '—';
  document.getElementById('modal-prompt-text').textContent = analysis.aiPrompt || '—';

  // Reset to first tab
  switchModalTab('viral');
  document.getElementById('detail-overlay').classList.add('open');
};

function switchModalTab(name) {
  document.querySelectorAll('.modal-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.modalTab === name)
  );
  document.querySelectorAll('.modal-content-block').forEach((b) =>
    b.classList.toggle('active', b.id === `modal-${name}`)
  );
}

document.querySelectorAll('.modal-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchModalTab(tab.dataset.modalTab));
});

function closeDetailOverlay() {
  const overlay = document.getElementById('detail-overlay');
  overlay?.classList.remove('open');
}

const modalCloseBtn = document.getElementById('modal-close');
if (modalCloseBtn) {
  // Use pointerdown so it still works even if a click is treated as a drag
  modalCloseBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDetailOverlay();
  });
  modalCloseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDetailOverlay();
  });
}

const detailOverlay = document.getElementById('detail-overlay');
if (detailOverlay) {
  detailOverlay.addEventListener('click', (e) => {
    // Backdrop click closes
    if (e.target === e.currentTarget) closeDetailOverlay();
  });
}

// ESC closes the detail modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetailOverlay();
});

document.getElementById('btn-copy-prompt').addEventListener('click', () => {
  const text = document.getElementById('modal-prompt-text').textContent;
  navigator.clipboard.writeText(text).then(() => toast('Prompt copied!', 'success'));
});

// =============================================
// EXPORT HELPERS
// =============================================
function buildExcelRows() {
  return state.results.map((r) => ({
    platform:  r.info.platform,
    creator:   r.info.creator,
    likes:     r.info.likes,
    comments:  r.info.comments,
    shares:    r.info.shares,
    duration:  r.info.duration,
    caption:   r.info.caption,
    url:       r.info.url,
    viral:     r.analysis?.viral    || '',
    lens:      r.analysis?.lens     || '',
    aiPrompt:  r.analysis?.aiPrompt || '',
  }));
}

function buildTsvString() {
  // Collapse newlines and tabs inside cell values so TSV rows stay intact
  const cell = (val) =>
    String(val || '-')
      .replace(/\r?\n/g, ' ')
      .replace(/\t/g, '  ')
      .trim();

  const headers = ['#','Platform','Creator','Likes','Comments','Shares/Remixes','Duration','Caption','URL','Viral Mechanics','Lens Analysis','AI Prompt'];
  const rows = state.results.map((r, i) => [
    i + 1,
    cell(r.info.platform),
    cell(r.info.creator),
    cell(r.info.likes),
    cell(r.info.comments),
    cell(r.info.shares),
    cell(r.info.duration),
    cell(r.info.caption),
    cell(r.info.url),
    cell(r.analysis?.viral),
    cell(r.analysis?.lens),
    cell(r.analysis?.aiPrompt),
  ]);
  // Use CRLF line endings for maximum Excel compatibility
  return [headers, ...rows].map((r) => r.join('\t')).join('\r\n');
}

// ── Copy Table ────────────────────────────────────────────
async function copyTable() {
  if (state.results.length === 0) return;
  const tsv = buildTsvString();
  try {
    // Use Electron's native clipboard (more reliable than browser API in Electron)
    await window.api.writeClipboard(tsv);
  } catch {
    await navigator.clipboard.writeText(tsv);
  }
  toast('Table copied — paste directly into Excel or Google Sheets', 'success');
}

// ── Export PDF ────────────────────────────────────────────
async function exportPdf() {
  if (state.results.length === 0) return;
  const res = await window.api.exportPdf(state.results);
  if (res.success) toast('PDF saved!', 'success');
  else if (!res.cancelled) toast(`PDF error: ${res.error}`, 'error', 5000);
}

// ── Export Excel ──────────────────────────────────────────
async function exportExcel() {
  if (state.results.length === 0) return;
  const rows = buildExcelRows();
  const res  = await window.api.exportExcel(rows);
  if (res.success) toast('Excel file saved!', 'success');
  else if (!res.cancelled) toast(`Excel error: ${res.error}`, 'error', 5000);
}

// Wire export buttons (single tab)
document.getElementById('btn-copy').addEventListener('click',  copyTable);
document.getElementById('btn-pdf').addEventListener('click',   exportPdf);
document.getElementById('btn-excel').addEventListener('click', exportExcel);

// Wire export buttons (bulk tab — same underlying data)
document.getElementById('btn-bulk-copy').addEventListener('click',  copyTable);
document.getElementById('btn-bulk-pdf').addEventListener('click',   exportPdf);
document.getElementById('btn-bulk-excel').addEventListener('click', exportExcel);

// =============================================
// HISTORY MANAGER MODAL
// =============================================
let historyAllUrls = [];       // full list loaded from file
let historySelected = new Set(); // currently ticked URLs

document.getElementById('btn-history').addEventListener('click', openHistoryModal);
document.getElementById('history-close').addEventListener('click', closeHistoryModal);
document.getElementById('history-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeHistoryModal();
});

document.getElementById('history-search').addEventListener('input', (e) => {
  renderHistoryList(e.target.value.trim().toLowerCase());
});

document.getElementById('history-select-all').addEventListener('click', () => {
  const filtered = getFilteredUrls();
  const allSelected = filtered.every((u) => historySelected.has(u));
  filtered.forEach((u) => (allSelected ? historySelected.delete(u) : historySelected.add(u)));
  renderHistoryList(document.getElementById('history-search').value.trim().toLowerCase());
  updateHistoryControls();
});

document.getElementById('history-remove-selected').addEventListener('click', async () => {
  if (historySelected.size === 0) return;
  const toRemove = Array.from(historySelected);
  const res = await window.api.removeHistoryUrls(toRemove);
  if (res.success) {
    historyAllUrls = historyAllUrls.filter((u) => !historySelected.has(u));
    historySelected.clear();
    renderHistoryList(document.getElementById('history-search').value.trim().toLowerCase());
    updateHistoryControls();
    toast(`Removed ${res.removed} URL(s) from history`, 'success');
  } else {
    toast(`Error: ${res.error}`, 'error');
  }
});

document.getElementById('history-clear-all').addEventListener('click', async () => {
  if (!historyAllUrls.length) return;
  await window.api.clearHistory();
  historyAllUrls = [];
  historySelected.clear();
  renderHistoryList('');
  updateHistoryControls();
  toast('History cleared', 'success');
  // Also refresh settings history count if settings is open
  loadHistoryCount();
});

document.getElementById('history-add-btn').addEventListener('click', addHistoryUrl);
document.getElementById('history-add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addHistoryUrl();
});

async function addHistoryUrl() {
  const input = document.getElementById('history-add-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await window.api.addHistoryUrl(url);
  if (res.success) {
    if (!historyAllUrls.includes(url)) historyAllUrls.push(url);
    input.value = '';
    renderHistoryList(document.getElementById('history-search').value.trim().toLowerCase());
    updateHistoryControls();
    toast('URL added to history', 'success');
  } else {
    toast(`Error: ${res.error}`, 'error');
  }
}

async function openHistoryModal() {
  historySelected.clear();
  document.getElementById('history-search').value = '';
  document.getElementById('history-list').innerHTML = '<div class="history-empty">Loading…</div>';
  document.getElementById('history-overlay').classList.add('open');

  const { urls } = await window.api.getHistoryUrls();
  historyAllUrls = urls;
  renderHistoryList('');
  updateHistoryControls();
}

function closeHistoryModal() {
  document.getElementById('history-overlay').classList.remove('open');
}

function getFilteredUrls(filter = '') {
  if (!filter) return historyAllUrls;
  return historyAllUrls.filter((u) => u.toLowerCase().includes(filter));
}

function renderHistoryList(filter) {
  const list = document.getElementById('history-list');
  const filtered = getFilteredUrls(filter);

  document.getElementById('history-total-badge').textContent =
    `${filtered.length} of ${historyAllUrls.length} URL(s)`;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="history-empty">${historyAllUrls.length === 0 ? 'No URLs in history yet.' : 'No URLs match your filter.'}</div>`;
    return;
  }

  list.innerHTML = filtered
    .map((url, i) => {
      const checked = historySelected.has(url);
      return `<div class="history-item${checked ? ' selected' : ''}" data-url="${escAttr(url)}">
        <input type="checkbox" id="hcb-${i}" ${checked ? 'checked' : ''} />
        <label class="history-url" for="hcb-${i}">${escHtml(url)}</label>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.history-item input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const item = cb.closest('.history-item');
      const url = item.dataset.url;
      if (cb.checked) {
        historySelected.add(url);
        item.classList.add('selected');
      } else {
        historySelected.delete(url);
        item.classList.remove('selected');
      }
      updateHistoryControls();
    });
  });
}

function updateHistoryControls() {
  const selCount = historySelected.size;
  document.getElementById('history-sel-count').textContent = selCount;
  document.getElementById('history-remove-selected').disabled = selCount === 0;

  const allBtn = document.getElementById('history-select-all');
  const filtered = getFilteredUrls(document.getElementById('history-search').value.trim().toLowerCase());
  const allTicked = filtered.length > 0 && filtered.every((u) => historySelected.has(u));
  allBtn.textContent = allTicked ? 'Deselect All' : 'Select All';
}

// =============================================
// SETTINGS MODAL
// =============================================
let settingsHeadless = false; // local toggle state (headless=false means SHOW browser)

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings();
});

document.getElementById('settings-headless-toggle').addEventListener('click', (btn) => {
  settingsHeadless = !settingsHeadless;
  btn.currentTarget.classList.toggle('on', !settingsHeadless);
});

document.getElementById('settings-save').addEventListener('click', saveSettings);
document.getElementById('btn-clear-history').addEventListener('click', async () => {
  await window.api.clearHistory();
  historyAllUrls = [];
  historySelected.clear();
  loadHistoryCount();
  toast('Analysis history cleared', 'success');
});

async function openSettings() {
  const config = await window.api.getConfig();
  document.getElementById('settings-model').value = config.model || 'claude-sonnet-4-20250514';
  settingsHeadless = config.headless;
  const toggle = document.getElementById('settings-headless-toggle');
  // headless:false → show browser → toggle ON
  toggle.classList.toggle('on', !settingsHeadless);
  await loadHistoryCount();
  document.getElementById('settings-overlay').classList.add('open');
}

async function loadHistoryCount() {
  const { count } = await window.api.getHistoryCount();
  document.getElementById('history-info').textContent =
    `${count} URL${count !== 1 ? 's' : ''} in history`;
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

async function saveSettings() {
  const model   = document.getElementById('settings-model').value.trim();
  const headless = settingsHeadless;

  const res = await window.api.saveConfig({ model, headless });
  if (res.success) {
    toast('Settings saved', 'success');
    closeSettings();
  } else {
    toast('Failed to save settings', 'error');
  }
}

// =============================================
// INIT
// =============================================
async function init() {
  // Nothing to check on startup — API key is built in
}

init();
