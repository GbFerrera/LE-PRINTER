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
  setFontSize: (size) => ipcRenderer.invoke('set-font-size', size),
  getFontSize: () => ipcRenderer.invoke('get-font-size'),

  // Printing
  printOrder: (order) => ipcRenderer.invoke('print-order', order),
  testPrinter: () => ipcRenderer.invoke('test-printer'),

  // WebSocket events
  onWebSocketStatus: (callback) => ipcRenderer.on('websocket-status', callback),
  onWebSocketError: (callback) => ipcRenderer.on('websocket-error', callback),
  onNewOrder: (callback) => ipcRenderer.on('new-order', callback),
  onPrintResult: (callback) => ipcRenderer.on('print-result', callback),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
