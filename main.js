const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const WebSocket = require('ws');
const { spawn, spawnSync } = require('child_process');
const fetch = require('node-fetch');
const {
  formatOrderText,
  formatTabText,
  formatFontSampleText,
  buildOrderReceipt,
  buildTabReceipt,
  buildFontSampleReceipt,
  documentToPlainText,
  normalizeFontScale,
  getFontScaleLabel,
  DEFAULT_FONT_SCALE,
} = require('./printFormat');

// Configurações para resolver problemas no Windows
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('allow-running-insecure-content');

// Em build empacotado, __dirname aponta para app.asar (não gravável no Windows).
// Então só usamos pasta local no modo dev; em produção usamos os paths padrão do sistema.
if (!app.isPackaged) {
  app.setPath('userData', path.join(__dirname, 'user-data'));
  app.setPath('cache', path.join(__dirname, 'cache'));
} else if (process.platform === 'win32') {
  // Evita problemas de permissão em Roaming com electron-store (config.json.tmp)
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const userDataPath = path.join(localAppData, 'link-eats-printer');
    const cachePath = path.join(userDataPath, 'Cache');
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(cachePath, { recursive: true });
      app.setPath('userData', userDataPath);
      app.setPath('cache', cachePath);
    } catch (error) {
      console.error('Failed to prepare Windows data directories:', error);
    }
  }
}

// Initialize store for persistent settings
const store = new Store();

let mainWindow;
let ws = null;
let printerProcess = null;
let isAutoPrintEnabled = store.get('autoPrintEnabled', false);
let deviceToken = store.get('deviceToken', null);
let deviceId = store.get('deviceId', null);
let companyId = store.get('companyId', null);
let companyName = store.get('companyName', null);
let printerReady = false;
let reconnectTimer = null;
let isConnecting = false;
let selectedPrinter = null;
let fontScale = normalizeFontScale(store.get('fontScale', store.get('fontSize', DEFAULT_FONT_SCALE)));
let paperWidth = store.get('paperWidth', '58mm') === '80mm' ? '80mm' : '58mm';
const recentlyPrinted = new Set(); // deduplication guard

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'public', 'icon.png'),
    path.join(process.resourcesPath || '', 'public', 'icon.png'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function resolveLogoPath() {
  const candidates = [
    path.join(__dirname, 'public', 'logo.png'),
    path.join(process.resourcesPath || '', 'public', 'logo.png'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

// Evita múltiplas instâncias concorrendo pelo mesmo arquivo de config (electron-store)
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function getPrintOptions() {
  return { paperWidth, fontScale };
}

function buildReceiptForOrder(order) {
  const options = getPrintOptions();
  if (order?.kind === 'tab_print') {
    return buildTabReceipt(order, companyName, options);
  }
  return buildOrderReceipt(order, companyName, options);
}

function buildPrinterCommandPayload(extra = {}) {
  return {
    font_scale: fontScale,
    paper_width: paperWidth,
    printer: selectedPrinter || undefined,
    // Logo removida; cupom em imagem (GDI) para controle da fonte em todos os tamanhos
    ...extra,
  };
}

// Backend configuration
const BACKEND_URL = 'https://api.linkeats.com.br';
const backendUrl = new URL(BACKEND_URL);
const wsProtocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${wsProtocol}//${backendUrl.host}/ws`;

// Handle print-order event - payload already contains full order data from backend
async function handlePrintOrderEvent(payload) {
  try {
    console.log(`🖨️ Print order event received: ${payload.id}`);
    const result = await printOrder(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-result', {
        orderId: payload.id,
        success: result.success,
        mode: result.mode,
        message: result.message,
        auto: true
      });
    }
  } catch (error) {
    console.error('Error handling print-order event:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-result', { orderId: payload.id, success: false, mode: 'error', message: error.message, auto: true });
    }
  }
}

function createWindow() {
  console.log('Creating window...');
  const iconPath = resolveAppIconPath();
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Link Eats - Impressora de Pedidos',
    icon: iconPath || undefined
  });

  console.log('Window created, loading HTML...');
  
  // Carregar HTML com tratamento de erro
  mainWindow.loadFile('index.html').catch(err => {
    console.error('Failed to load index.html:', err);
    // Carregar página de fallback
    mainWindow.loadURL('data:text/html,<html><body><h1>Link Eats Printer</h1><p>App carregado com sucesso!</p></body></html>');
  });

  // Eventos da janela
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
    mainWindow.maximize();
    mainWindow.show(); // Mostrar janela após carregar
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load page:', errorCode, errorDescription);
  });

  // Remove menu bar in production
  if (!process.argv.includes('--dev')) {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.on('closed', () => {
    console.log('Window closed');
    mainWindow = null;
    if (ws) {
      ws.close();
    }
  });
}

function getPythonSearchDirs() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(localAppData, 'Programs', 'Python', 'Python314'),
    path.join(localAppData, 'Programs', 'Python', 'Python313'),
    path.join(localAppData, 'Programs', 'Python', 'Python312'),
    path.join(localAppData, 'Programs', 'Python', 'Python311'),
    path.join(localAppData, 'Programs', 'Python', 'Python310'),
    path.join(localAppData, 'Programs', 'Python', 'Launcher'),
    path.join(programFiles, 'Python314'),
    path.join(programFiles, 'Python313'),
    path.join(programFiles, 'Python312'),
    path.join(programFiles, 'Python311'),
  ].filter((dir) => dir && fs.existsSync(dir));
}

function getAugmentedPath() {
  const extra = getPythonSearchDirs().join(path.delimiter);
  return [extra, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

function resolvePythonCommand() {
  const absoluteCandidates = getPythonSearchDirs().flatMap((dir) => [
    path.join(dir, 'python.exe'),
    path.join(dir, 'py.exe'),
  ]);

  const pathCandidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];

  const candidates = [
    ...absoluteCandidates.filter((p) => fs.existsSync(p)),
    ...pathCandidates,
  ];

  const env = { ...process.env, PATH: getAugmentedPath() };

  for (const cmd of candidates) {
    // Skip Windows Store stub that only opens the Store page
    if (typeof cmd === 'string' && cmd.toLowerCase().includes('\\windowsapps\\')) {
      continue;
    }
    try {
      const args = cmd.toLowerCase().endsWith('py.exe') || cmd === 'py'
        ? ['-3', '--version']
        : ['--version'];
      const result = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        env,
      });
      if (result.status === 0) {
        console.log(`Python found: ${cmd}`);
        return cmd;
      }
    } catch {}
  }
  return null;
}

// Initialize Python printer process
function initializePrinter() {
  try {
    if (printerProcess) {
      return Boolean(printerReady);
    }

    // Prefer native Windows EXE if available (packaged via PyInstaller)
    if (process.platform === 'win32') {
      const exeName = 'printer-win.exe';
      const packagedExe = path.join(process.resourcesPath, 'bin', exeName);
      const devExe = path.join(__dirname, 'bin', exeName);
      const exePath = app.isPackaged && fs.existsSync(packagedExe)
        ? packagedExe
        : (fs.existsSync(devExe) ? devExe : null);

      if (exePath) {
        console.log(`Attempting to start bundled printer engine: ${exePath}`);
        printerProcess = spawn(exePath, [], { windowsHide: true });
      }
    }

    // Fallback to Python script if no EXE available
    if (!printerProcess) {
      const pythonPath = resolvePythonCommand();
      if (!pythonPath) {
        console.log('Python not found — running in simulation mode');
        printerReady = false;
        return false;
      }
      const scriptPath = app.isPackaged
        ? path.join(process.resourcesPath, 'printer.py')
        : path.join(__dirname, 'printer.py');
      const pythonArgs = (pythonPath.toLowerCase().endsWith('py.exe') || pythonPath === 'py')
        ? ['-3', scriptPath]
        : [scriptPath];
      console.log(`Attempting to start Python printer with: ${pythonPath} ${pythonArgs.join(' ')}`);
      printerProcess = spawn(pythonPath, pythonArgs, {
        windowsHide: true,
        env: { ...process.env, PATH: getAugmentedPath() },
      });
    }

    printerProcess.on('error', (error) => {
      console.error('Failed to start Python process:', error.message);
      console.log('Running in simulation mode - Python/pywin32 not available');
      printerReady = false;
      printerProcess = null;
    });

    printerProcess.stdout.on('data', (data) => {
      console.log(`Printer output: ${data}`);
    });

    printerProcess.stderr.on('data', (data) => {
      console.error(`Printer error: ${data}`);
    });

    printerProcess.on('close', (code) => {
      console.log(`Printer process exited with code ${code}`);
      printerReady = false;
      printerProcess = null;
    });

    printerReady = true;
    console.log('Printer process initialized successfully');
    return true;
  } catch (error) {
    console.log('Failed to initialize printer process:', error);
    printerProcess = null;
    printerReady = false;
    return false;
  }
}

// Send command to Python printer
function sendPrinterCommand(command) {
  return new Promise((resolve, reject) => {
    if (!printerProcess || !printerReady || !printerProcess.stdout || !printerProcess.stdin) {
      reject(new Error('Printer process not ready'));
      return;
    }

    const proc = printerProcess;
    let responseData = '';
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (proc.stdout) proc.stdout.removeListener('data', dataHandler);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    const dataHandler = (data) => {
      responseData += data.toString();
      try {
        const response = JSON.parse(responseData.trim());
        finish(resolve, response);
      } catch (e) {
        // Ainda não recebeu JSON completo
      }
    };

    const onClose = () => {
      printerReady = false;
      if (printerProcess === proc) printerProcess = null;
      finish(reject, new Error('Printer process exited'));
    };

    const onError = (error) => {
      printerReady = false;
      if (printerProcess === proc) printerProcess = null;
      finish(reject, error);
    };

    timeout = setTimeout(() => {
      finish(reject, new Error('Printer command timeout'));
    }, 10000);

    proc.stdout.on('data', dataHandler);
    proc.once('close', onClose);
    proc.once('error', onError);

    try {
      proc.stdin.write(JSON.stringify(command) + '\n');
    } catch (error) {
      finish(reject, error);
    }
  });
}

// Print order function
// Returns { success, mode: 'simulation'|'printer', message }
async function printOrder(order) {
  if (!printerProcess || !printerReady) {
    console.log('=== SIMULAÇÃO DE IMPRESSÃO ===');
    console.log(order?.kind === 'tab_print'
      ? formatTabText(order, companyName, getPrintOptions())
      : formatOrderText(order, companyName, getPrintOptions()));
    console.log('=== FIM DA SIMULAÇÃO ===');
    return { success: true, mode: 'simulation', message: 'Sem impressora conectada — enviado para fila de simulação' };
  }

  try {
    const receipt = buildReceiptForOrder(order);
    const response = await sendPrinterCommand(buildPrinterCommandPayload({
      action: 'print',
      receipt,
      text: documentToPlainText(receipt),
      printer: selectedPrinter || undefined,
    }));

    if (response.success) {
      console.log('Order printed successfully:', response.message);
      return { success: true, mode: 'printer', message: response.message || 'Enviado para a impressora' };
    } else {
      console.error('Failed to print order:', response.error);
      return { success: false, mode: 'printer', message: response.error };
    }
  } catch (error) {
    console.error('Failed to print order:', error);
    return { success: false, mode: 'printer', message: error.message };
  }
}

async function loadCompanyName(companyIdToLoad) {
  if (!companyIdToLoad) return null
  try {
    const res = await fetch(`${BACKEND_URL}/public/menu/company`, {
      headers: { company_id: companyIdToLoad }
    })
    if (res.ok) {
      const data = await res.json()
      const name = data.display_name || data.name || null
      if (name) {
        companyName = name
        store.set('companyName', name)
      }
      return name
    }
  } catch {}
  companyName = store.get('companyName', null)
  return companyName
}

function clearDeviceSession() {
  deviceToken = null;
  deviceId = null;
  companyId = null;
  companyName = null;
  store.delete('deviceToken');
  store.delete('deviceId');
  store.delete('companyId');
  store.delete('companyName');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function notifyAccessRevoked(reason) {
  const message = reason || 'Acesso revogado';
  console.log('🚫 Access revoked:', message);
  clearDeviceSession();
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('websocket-status', { connected: false });
    mainWindow.webContents.send('device-access-revoked', { message });
  }
}

// WebSocket connection (auth-printer)
function connectWebSocket() {
  if (isConnecting) return;
  if (!deviceToken) {
    console.log('⚠️ Cannot connect: missing device token');
    return;
  }

  if (ws) {
    try { ws.terminate(); } catch {} ws = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  isConnecting = true;
  console.log(`🔌 Connecting to WebSocket: ${WS_URL}`);

  const socket = new WebSocket(WS_URL);
  ws = socket;

  socket.on('open', () => {
    isConnecting = false;
    console.log('✅ WebSocket connected');

    try {
      socket.send(JSON.stringify({
        type: 'auth-printer',
        payload: { deviceToken }
      }));
      console.log('🖨️ Authenticating printer device...');
    } catch (e) {
      console.error('❌ Failed to send auth-printer:', e.message);
    }
  });

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 WS message:', data.type);

      if (data.type === 'printer-authenticated') {
        companyId = data.payload?.companyId || null;
        deviceId = data.payload?.deviceId || deviceId;
        store.set('deviceToken', deviceToken);
        if (deviceId) store.set('deviceId', deviceId);
        if (companyId) store.set('companyId', companyId);
        loadCompanyName(companyId);
        console.log('✅ Printer authenticated. Company:', companyId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('websocket-status', { connected: true, companyId, deviceId });
        }
      } else if (
        data.type === 'printer-auth-failed' ||
        data.type === 'printer-revoked' ||
        data.type === 'device-revoked' ||
        data.type === 'printer-unpaired' ||
        data.type === 'printer-removed'
      ) {
        notifyAccessRevoked(data.payload?.message || 'Acesso da impressora revogado');
      } else if (data.type === 'new-order') {
        console.log('🔔 New order received:', data.payload?.id);
        // Always show in UI list - print-order event handles actual printing
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-order', data.payload);
        }
      } else if (data.type === 'print-order') {
        const orderId = data.payload?.id;
        console.log('🖨️ Print order event received:', orderId);
        // Ensure manual/command prints also appear in pending list UI
        // (renderer deduplicates by order id).
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-order', data.payload);
        }
        if (!isAutoPrintEnabled) {
          console.log('⚠️ Auto-print disabled — skipping automatic print for:', orderId);
        } else if (orderId && recentlyPrinted.has(orderId)) {
          // Deduplication: ignore if same order printed in last 3 seconds
          console.log('⚠️ Duplicate print-order ignored:', orderId);
        } else {
          if (orderId) {
            recentlyPrinted.add(orderId);
            setTimeout(() => recentlyPrinted.delete(orderId), 3000);
          }
          handlePrintOrderEvent(data.payload);
        }
      } else if (data.type === 'print-tab') {
        const tabPrintId = data.payload?.id;
        console.log('🧾 Print tab event received:', tabPrintId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-order', data.payload);
        }
        if (!isAutoPrintEnabled) {
          console.log('⚠️ Auto-print disabled — skipping automatic tab print for:', tabPrintId);
        } else {
          printOrder(data.payload).then((result) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('print-result', {
                orderId: tabPrintId,
                success: result.success,
                mode: result.mode,
                message: result.message,
                auto: true
              });
            }
          });
        }
      } else if (data.type === 'order-status-update') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('order-status-update', data.payload);
        }
      } else if (data.type === 'order-canceled') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('order-canceled', data.payload);
        }
      } else if (data.type === 'order-scheduled') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('order-scheduled', data.payload);
        }
      } else if (data.type === 'pong') {
        // heartbeat response
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });

  socket.on('close', (code) => {
    isConnecting = false;
    console.log(`❌ WebSocket disconnected (code: ${code})`);
    if (ws === socket) ws = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('websocket-status', { connected: false });
    }
    // Auto-reconnect after 5 seconds if we still have a token
    if (deviceToken) {
      console.log('🔄 Reconnecting in 5s...');
      reconnectTimer = setTimeout(() => connectWebSocket(), 5000);
    }
  });

  socket.on('error', (error) => {
    isConnecting = false;
    console.error('❌ WebSocket error:', error.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('websocket-error', error.message);
    }
  });
}

// IPC handlers

// Login with email/password
ipcMain.handle('login', async (event, { email, password }) => {
  try {
    const response = await fetch(`${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const err = await response.json();
      return { success: false, error: err.message || 'Credenciais inválidas' };
    }

    const data = await response.json();
    store.set('email', email);
    store.set('user', data.user);
    return { success: true, user: data.user };
  } catch (error) {
    console.error('Login error:', error);
    return { success: false, error: error.message || 'Erro de conexão' };
  }
});

ipcMain.handle('get-stored-credentials', () => {
  return {
    email: store.get('email', ''),
    user: store.get('user', null)
  };
});

ipcMain.handle('get-stored-device-info', () => {
  return {
    paired: Boolean(store.get('deviceToken', null)),
    deviceId: store.get('deviceId', null),
    companyId: store.get('companyId', null),
    companyName: store.get('companyName', null)
  };
});

ipcMain.handle('connect-stored-device', () => {
  deviceToken = store.get('deviceToken', null);
  deviceId = store.get('deviceId', null);
  companyId = store.get('companyId', null);
  companyName = store.get('companyName', null);

  if (!deviceToken) {
    return { success: false, error: 'Nenhuma impressora vinculada' };
  }

  connectWebSocket();
  return { success: true };
});

ipcMain.handle('claim-pair-code', async (_event, { code, deviceName }) => {
  try {
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) {
      return { success: false, error: 'Código inválido' };
    }

    const response = await fetch(`${BACKEND_URL}/printer/pair/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalizedCode, deviceName })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, error: data?.message || 'Código inválido ou expirado' };
    }

    deviceToken = data.deviceToken;
    deviceId = data.deviceId;
    companyId = data.companyId;

    store.set('deviceToken', deviceToken);
    store.set('deviceId', deviceId);
    store.set('companyId', companyId);

    loadCompanyName(companyId);
    connectWebSocket();

    return { success: true, companyId, deviceId };
  } catch (error) {
    return { success: false, error: error.message || 'Erro ao vincular' };
  }
});

ipcMain.handle('disconnect-device', () => {
  clearDeviceSession();
  if (ws) { try { ws.terminate(); } catch {} ws = null; }
  return { success: true };
});

ipcMain.handle('toggle-auto-print', (event, enabled) => {
  isAutoPrintEnabled = enabled;
  store.set('autoPrintEnabled', enabled);
  return { success: true };
});

ipcMain.handle('get-auto-print-status', () => {
  return isAutoPrintEnabled;
});

ipcMain.handle('list-printers', async () => {
  if (!printerProcess || !printerReady) {
    const initialized = initializePrinter();
    if (!initialized) return { success: false, printers: [] };
  }
  try {
    const response = await sendPrinterCommand({ action: 'list_printers' });
    return { success: true, printers: response.printers || [] };
  } catch (e) {
    return { success: false, printers: [] };
  }
});

ipcMain.handle('set-printer', (event, printerName) => {
  selectedPrinter = printerName || null;
  store.set('selectedPrinter', selectedPrinter);
  return { success: true };
});

ipcMain.handle('get-selected-printer', () => {
  selectedPrinter = store.get('selectedPrinter', null);
  return { printer: selectedPrinter };
});

ipcMain.handle('set-font-size', (_event, size) => {
  fontScale = normalizeFontScale(size);
  store.set('fontScale', fontScale);
  store.delete('fontSize');
  return { success: true, font_scale: fontScale, label: getFontScaleLabel(fontScale) };
});

ipcMain.handle('get-font-size', () => {
  fontScale = normalizeFontScale(store.get('fontScale', store.get('fontSize', DEFAULT_FONT_SCALE)));
  return {
    font_scale: fontScale,
    font_size: String(fontScale),
    label: getFontScaleLabel(fontScale),
    paper_width: paperWidth,
  };
});

ipcMain.handle('set-paper-width', (_event, width) => {
  paperWidth = width === '80mm' ? '80mm' : '58mm';
  store.set('paperWidth', paperWidth);
  return { success: true, paper_width: paperWidth };
});

ipcMain.handle('get-paper-width', () => {
  paperWidth = store.get('paperWidth', '58mm') === '80mm' ? '80mm' : '58mm';
  return { paper_width: paperWidth };
});

ipcMain.handle('print-font-sample', async () => {
  const receipt = buildFontSampleReceipt(fontScale, paperWidth, getPrintOptions());
  const sampleText = documentToPlainText(receipt);
  if (!printerProcess || !printerReady) {
    const initialized = initializePrinter();
    if (!initialized) {
      console.log('=== AMOSTRA DE FONTE (SIMULAÇÃO) ===');
      console.log(sampleText);
      return { success: true, message: 'Amostra gerada em modo simulação (veja o console)' };
    }
  }

  try {
    const response = await sendPrinterCommand(buildPrinterCommandPayload({
      action: 'test',
      receipt,
      text: sampleText,
      date: new Date().toLocaleString('pt-BR'),
    }));
    if (response.success) {
      return { success: true, message: response.message || 'Amostra impressa' };
    }
    return { success: false, message: response.error || 'Falha ao imprimir amostra' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('print-order', async (event, order) => {
  const result = await printOrder(order);
  return result;
});

ipcMain.handle('test-printer', async () => {
  if (!printerProcess || !printerReady) {
    const initialized = initializePrinter();
    if (!initialized) {
      console.log('=== TESTE DE IMPRESSORA (SIMULAÇÃO) ===');
      console.log('TESTE DE IMPRESSORA');
      console.log('Link Eats - Sistema funcionando!');
      console.log(new Date().toLocaleString('pt-BR'));
      console.log('Modo simulação ativo - conecte uma impressora');
      console.log('=== FIM DO TESTE ===');
      return { success: true, message: 'Teste executado em modo simulação' };
    }
  }

  try {
    const response = await sendPrinterCommand(buildPrinterCommandPayload({
      action: 'test',
      date: new Date().toLocaleString('pt-BR'),
    }));
    
    if (response.success) {
      return { success: true, message: response.message || 'Teste impresso com sucesso' };
    } else {
      return { success: false, error: response.error };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Auto-updater state
let pendingUpdate = null;
let downloadedUpdatePath = null;

function parseSemver(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return String(a || '').localeCompare(String(b || ''));
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function isRemoteVersionNewer(remote, current) {
  return compareSemver(remote, current) > 0;
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function fetchLatestReleaseInfo() {
  const res = await fetch(`${BACKEND_URL}/downloads/printer/windows/version`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || 'Nenhuma versão publicada');
  }
  return res.json();
}

async function checkForUpdates({ silent = false } = {}) {
  if (!app.isPackaged) {
    if (!silent) {
      notifyRenderer('update-not-available', {
        currentVersion: app.getVersion(),
        message: 'Modo desenvolvimento — atualização desativada'
      });
    }
    return { available: false, reason: 'dev_mode' };
  }

  try {
    const data = await fetchLatestReleaseInfo();
    const currentVersion = app.getVersion();
    const remoteVersion = data.version;

    if (remoteVersion && isRemoteVersionNewer(remoteVersion, currentVersion)) {
      pendingUpdate = {
        version: remoteVersion,
        downloadUrl: data.downloadUrl || data.updateUrl,
        releaseNotes: data.releaseNotes || '',
        sha512: data.sha512 || null,
        fileSize: data.fileSize || null
      };
      downloadedUpdatePath = null;

      notifyRenderer('update-available', {
        currentVersion,
        version: remoteVersion,
        releaseNotes: pendingUpdate.releaseNotes,
        fileSize: pendingUpdate.fileSize
      });

      return { available: true, update: pendingUpdate };
    }

    pendingUpdate = null;
    notifyRenderer('update-not-available', {
      currentVersion,
      version: remoteVersion || currentVersion,
      message: 'Você está na versão mais recente'
    });
    return { available: false };
  } catch (err) {
    if (!silent) {
      notifyRenderer('update-error', { message: err.message || 'Erro ao verificar atualizações' });
    }
    return { available: false, error: err.message };
  }
}

async function downloadPendingUpdate() {
  if (!pendingUpdate?.downloadUrl) {
    throw new Error('Nenhuma atualização disponível');
  }

  const tempPath = path.join(
    app.getPath('temp'),
    `link-eats-printer-update-${pendingUpdate.version}.exe`
  );

  notifyRenderer('update-download-progress', { percent: 0, transferred: 0, total: pendingUpdate.fileSize || 0 });

  const downloadRes = await fetch(pendingUpdate.downloadUrl);
  if (!downloadRes.ok) {
    throw new Error('Falha ao baixar atualização');
  }

  const totalHeader = Number(downloadRes.headers.get('content-length') || pendingUpdate.fileSize || 0);
  let transferred = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(tempPath);
    downloadRes.body.on('data', (chunk) => {
      transferred += chunk.length;
      const percent = totalHeader > 0 ? Math.min(100, Math.round((transferred / totalHeader) * 100)) : 0;
      notifyRenderer('update-download-progress', { percent, transferred, total: totalHeader });
    });
    downloadRes.body.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    downloadRes.body.pipe(fileStream);
  });

  downloadedUpdatePath = tempPath;
  notifyRenderer('update-downloaded', {
    version: pendingUpdate.version,
    path: tempPath
  });

  return { success: true, path: tempPath };
}

function installDownloadedUpdate() {
  if (!downloadedUpdatePath || !fs.existsSync(downloadedUpdatePath)) {
    throw new Error('Baixe a atualização antes de instalar');
  }

  const child = spawn(downloadedUpdatePath, ['/S', '/force'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  app.quit();
  return { success: true };
}

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('check-for-updates', async () => {
  try {
    return await checkForUpdates({ silent: false });
  } catch (error) {
    return { available: false, error: error.message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    if (!pendingUpdate) {
      await checkForUpdates({ silent: false });
    }
    return await downloadPendingUpdate();
  } catch (error) {
    notifyRenderer('update-error', { message: error.message || 'Erro ao baixar atualização' });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-update', () => {
  try {
    return installDownloadedUpdate();
  } catch (error) {
    notifyRenderer('update-error', { message: error.message || 'Erro ao instalar atualização' });
    return { success: false, error: error.message };
  }
});

// App events
app.whenReady().then(() => {
  console.log('App is ready, creating window...');
  const iconPath = resolveAppIconPath();
  if (process.platform === 'darwin' && app.dock && iconPath) {
    const dockIcon = nativeImage.createFromPath(iconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }
  createWindow();
  
  // Try to initialize printer, but don't block the app if it fails
  setTimeout(() => {
    initializePrinter();
  }, 1000);

  // Check for updates on startup (silent detection only)
  setTimeout(() => {
    checkForUpdates({ silent: true });
  }, 3000);

  // Check for updates every 1 hour
  setInterval(() => {
    checkForUpdates({ silent: true });
  }, 3600000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  console.log('All windows closed');
  if (process.platform !== 'darwin') {
    console.log('Quitting app...');
    app.quit();
  }
});

app.on('before-quit', () => {
  console.log('App is about to quit');
  if (ws) {
    ws.close();
  }
  if (printerProcess) {
    printerProcess.kill();
  }
});

app.on('will-quit', () => {
  console.log('App will quit');
});

app.on('quit', () => {
  console.log('App has quit');
});

// Capturar todos os erros globais
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Manter o app vivo para ver o erro
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
