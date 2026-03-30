'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Analysis ──────────────────────────────────────────────
  analyzeSingle: (url) =>
    ipcRenderer.invoke('analyze-single', { url }),

  analyzeBulk: (keyword, platforms, limit, thresholds) =>
    ipcRenderer.invoke('analyze-bulk', { keyword, platforms, limit, thresholds }),

  stopBulk: () =>
    ipcRenderer.invoke('stop-bulk'),

  // ── Export ────────────────────────────────────────────────
  exportExcel: (rows) =>
    ipcRenderer.invoke('export-excel', { rows }),

  exportPdf: (results) =>
    ipcRenderer.invoke('export-pdf', { results }),

  writeClipboard: (text) =>
    ipcRenderer.invoke('write-clipboard', text),

  // ── Config ────────────────────────────────────────────────
  getConfig: () =>
    ipcRenderer.invoke('get-config'),

  saveConfig: (config) =>
    ipcRenderer.invoke('save-config', config),

  // ── Utilities ─────────────────────────────────────────────
  openExternal: (url) =>
    ipcRenderer.invoke('open-external', url),

  clearHistory: () =>
    ipcRenderer.invoke('clear-history'),

  getHistoryCount: () =>
    ipcRenderer.invoke('get-history-count'),

  getHistoryUrls: () =>
    ipcRenderer.invoke('get-history-urls'),

  removeHistoryUrls: (urlsToRemove) =>
    ipcRenderer.invoke('remove-history-urls', { urlsToRemove }),

  addHistoryUrl: (url) =>
    ipcRenderer.invoke('add-history-url', { url }),

  // ── Streaming events from main process ────────────────────
  onBulkProgress: (callback) =>
    ipcRenderer.on('bulk-progress', (_event, data) => callback(data)),

  offBulkProgress: () =>
    ipcRenderer.removeAllListeners('bulk-progress'),

});
