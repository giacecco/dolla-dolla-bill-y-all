'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ddbya', {
  getTags:        ()           => ipcRenderer.invoke('get-tags'),
  getPastTags:    ()           => ipcRenderer.invoke('get-past-tags'),
  saveTags:       (tags)       => ipcRenderer.invoke('save-tags', tags),
  exportCsv:      (from, to)   => ipcRenderer.invoke('export-csv', { from, to }),
  saveCsv:        (csv, name)  => ipcRenderer.invoke('save-csv', { csv, defaultName: name }),
  getSettings:     ()           => ipcRenderer.invoke('get-settings'),
  saveSettings:    (s)          => ipcRenderer.invoke('save-settings', s),
  copyToClipboard:  (text)       => ipcRenderer.invoke('copy-to-clipboard', text),
  closeWindow:      ()           => ipcRenderer.invoke('close-window'),
  getPricingPath:   ()           => ipcRenderer.invoke('get-pricing-path'),
  openPricingDialog: ()          => ipcRenderer.invoke('open-pricing-dialog'),
  clearPricing:     ()           => ipcRenderer.invoke('clear-pricing'),
});
