'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ddbya', {
  getTags:        ()           => ipcRenderer.invoke('get-tags'),
  getPastTags:    ()           => ipcRenderer.invoke('get-past-tags'),
  saveTags:       (tags)       => ipcRenderer.invoke('save-tags', tags),
  exportCsv:      (from, to)   => ipcRenderer.invoke('export-csv', { from, to }),
  saveCsv:        (csv, name)  => ipcRenderer.invoke('save-csv', { csv, defaultName: name }),
  getSettings:    ()           => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s)          => ipcRenderer.invoke('save-settings', s),
});
