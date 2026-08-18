const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Authentication
  login: (credentials) => ipcRenderer.invoke('login', credentials),
  getStoredCredentials: () => ipcRenderer.invoke('get-stored-credentials'),

  // Printer pairing (QR/código)
  claimPairCode: (code, deviceName) => ipcRenderer.invoke('claim-pair-code', { code, deviceName }),
  connectStoredDevice: () => ipcRenderer.invoke('connect-stored-device'),
  disconnectDevice: () => ipcRenderer.invoke('disconnect-device'),
  getStoredDeviceInfo: () => ipcRenderer.invoke('get-stored-device-info'),

  // Auto-print settings
  toggleAutoPrint: (enabled) => ipcRenderer.invoke('toggle-auto-print', enabled),
  getAutoPrintStatus: () => ipcRenderer.invoke('get-auto-print-status'),

  // Printer selection
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  setPrinter: (name) => ipcRenderer.invoke('set-printer', name),
  getSelectedPrinter: () => ipcRenderer.invoke('get-selected-printer'),
  getPrinterRouting: () => ipcRenderer.invoke('get-printer-routing'),
  setPrinterRouting: (routing) => ipcRenderer.invoke('set-printer-routing', routing),
  listMenuCategories: () => ipcRenderer.invoke('list-menu-categories'),
  setFontSize: (size) => ipcRenderer.invoke('set-font-size', size),
  getFontSize: () => ipcRenderer.invoke('get-font-size'),
  setPaperWidth: (width) => ipcRenderer.invoke('set-paper-width', width),
  getPaperWidth: () => ipcRenderer.invoke('get-paper-width'),
  printFontSample: () => ipcRenderer.invoke('print-font-sample'),
  printScaleTicket: (payload) => ipcRenderer.invoke('print-scale-ticket', payload),
  scaleActivateCard: (payload) => ipcRenderer.invoke('scale-activate-card', payload),
  scaleListTabCards: (payload) => ipcRenderer.invoke('scale-list-tab-cards', payload),
  scaleListWeighableProducts: () => ipcRenderer.invoke('scale-list-weighable-products'),

  // Printing
  printOrder: (order) => ipcRenderer.invoke('print-order', order),
  testPrinter: () => ipcRenderer.invoke('test-printer'),

  // WebSocket events
  onWebSocketStatus: (callback) => ipcRenderer.on('websocket-status', callback),
  onWebSocketError: (callback) => ipcRenderer.on('websocket-error', callback),
  onDeviceAccessRevoked: (callback) => ipcRenderer.on('device-access-revoked', callback),
  onNewOrder: (callback) => ipcRenderer.on('new-order', callback),
  onPrintResult: (callback) => ipcRenderer.on('print-result', callback),

  // Scale (serial auto-detect)
  scaleGetStatus: () => ipcRenderer.invoke('scale-get-status'),
  scaleListPorts: () => ipcRenderer.invoke('scale-list-ports'),
  scaleConnect: (options) => ipcRenderer.invoke('scale-connect', options),
  scaleStop: () => ipcRenderer.invoke('scale-stop'),
  scaleSetPrice: (price) => ipcRenderer.invoke('scale-set-price', price),
  onScaleWeight: (callback) => ipcRenderer.on('scale-weight', (_e, data) => callback(data)),
  onScaleStatus: (callback) => ipcRenderer.on('scale-status', (_e, data) => callback(data)),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // App updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', callback),
  onUpdateDownloadProgress: (callback) => ipcRenderer.on('update-download-progress', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  onUpdateError: (callback) => ipcRenderer.on('update-error', callback)
});
