const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

// Configurações para resolver problemas no Windows
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('allow-running-insecure-content');

// Definir diretórios de cache para local com permissão
app.setPath('userData', path.join(__dirname, 'user-data'));
app.setPath('cache', path.join(__dirname, 'cache'));

// Initialize store for persistent settings
const store = new Store();

let mainWindow;
let ws = null;
let printerProcess = null;
let isAutoPrintEnabled = store.get('autoPrintEnabled', false);
let kdsToken = null;
let companyId = null;
let companyName = null;
let printerReady = false;
let reconnectTimer = null;
let isConnecting = false;
let selectedPrinter = null;
const recentlyPrinted = new Set(); // deduplication guard

// Backend configuration
const BACKEND_URL = 'https://api.linkeats.com.br';
const backendUrl = new URL(BACKEND_URL);
const wsProtocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${wsProtocol}//${backendUrl.host}/ws`;

// Decode JWT payload (no verification needed - backend validates on connect)
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

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

// Helper functions for text formatting
function getOrderTypeText(type) {
  const types = {
    'delivery': 'Entrega',
    'pickup': 'Retirada',
    'presential': 'Presencial'
  };
  return types[type] || type;
}

function getStatusText(status) {
  const statuses = {
    'new': 'Novo',
    'preparing': 'Preparando',
    'ready': 'Pronto',
    'delivered': 'Entregue',
    'canceled': 'Cancelado',
    'scheduled': 'Agendado'
  };
  return statuses[status] || status;
}

function getPaymentMethodText(method) {
  const methods = {
    'money': 'Dinheiro',
    'pix': 'PIX',
    'card': 'Cartão',
    'credit_card': 'Cartão de Crédito',
    'debit_card': 'Cartão de Débito'
  };
  return methods[method] || method;
}

function createWindow() {
  console.log('Creating window...');
  
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false, // Manter oculta inicialmente
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Link Eats - Impressora de Pedidos'
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

// Initialize Python printer process
function initializePrinter() {
  try {
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
      const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
      const scriptPath = app.isPackaged
        ? path.join(process.resourcesPath, 'printer.py')
        : path.join(__dirname, 'printer.py');
      console.log(`Attempting to start Python printer with: ${pythonPath} ${scriptPath}`);
      printerProcess = spawn(pythonPath, [scriptPath]);
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
    if (!printerProcess || !printerReady) {
      reject(new Error('Printer process not ready'));
      return;
    }
    
    let responseData = '';
    
    const dataHandler = (data) => {
      responseData += data.toString();
      try {
        const response = JSON.parse(responseData.trim());
        printerProcess.stdout.removeListener('data', dataHandler);
        resolve(response);
      } catch (e) {
        // Ainda não recebeu JSON completo
      }
    };
    
    printerProcess.stdout.on('data', dataHandler);
    
    // Timeout de 10 segundos
    setTimeout(() => {
      printerProcess.stdout.removeListener('data', dataHandler);
      reject(new Error('Printer command timeout'));
    }, 10000);
    
    printerProcess.stdin.write(JSON.stringify(command) + '\n');
  });
}

// Format order for printing
function formatOrderText(order) {
  // Debug: Log all order fields to identify source of duplicate item observations
  console.log('🔍 DEBUG: Order object keys:', Object.keys(order));
  console.log('🔍 DEBUG: Order object (first 500 chars):', JSON.stringify(order).substring(0, 500));
  
  let text = '';
  const empresa = companyName || 'LINK EATS';
  const pad = Math.max(0, Math.floor((32 - empresa.length) / 2));
  
  text += '================================\n';
  text += ' '.repeat(pad) + empresa + '\n';
  text += '         NOVO PEDIDO\n';
  text += '================================\n';
  text += `Pedido: #${order.id.substring(0, 8)}\n`;
  text += `Tipo: ${getOrderTypeText(order.order_type)}\n`;
  text += `Status: ${getStatusText(order.status)}\n`;
  text += `Data: ${new Date(order.created_at).toLocaleString('pt-BR')}\n`;
  
  if (order.is_scheduled && order.scheduled_for) {
    text += `Agendado para: ${new Date(order.scheduled_for).toLocaleString('pt-BR')}\n`;
  }
  if (order.order_number) {
    text += `N. Pedido: ${order.order_number}\n`;
  }
  
  text += '================================\n';
  text += 'CLIENTE:\n';
  text += `Nome: ${order.customer_name || 'Nao informado'}\n`;
  text += `Telefone: ${order.customer_phone || 'Nao informado'}\n`;
  
  if (order.order_type === 'delivery' && order.address_street) {
    text += '\n';
    text += 'ENDERECO DE ENTREGA:\n';
    text += `${order.address_street}, ${order.address_number || 'S/N'}\n`;
    if (order.address_complement) {
      text += `${order.address_complement}\n`;
    }
    text += `${order.address_neighborhood} - ${order.address_city}\n`;
    if (order.address_zip) {
      text += `CEP: ${order.address_zip}\n`;
    }
    if (order.address_reference) {
      text += `Ref: ${order.address_reference}\n`;
    }
  }
  
  text += '================================\n';
  text += 'ITENS DO PEDIDO:\n';
  
  if (order.items && order.items.length > 0) {
    order.items.forEach((item, index) => {
      text += `${index + 1}. ${item.quantity}x ${item.product?.name || item.name || 'Item'}\n`;
      
      // Show item observations right after item name
      const itemObs = item.observations || item.observation || item.notes || item.obs || '';
      if (itemObs) {
        text += `   Obs: ${itemObs}\n`;
      }
      
      if (item.price) {
        text += `   Valor unit: R$ ${parseFloat(item.price).toFixed(2)}\n`;
        
        // Calculate total complement price for this item
        let complementTotal = 0;
        if (item.complements && item.complements.length > 0) {
          item.complements.forEach(c => {
            const cName = c.complement?.name || c.Complement?.name || '';
            if (cName) {
              const cPrice = c.price ? parseFloat(c.price) : 0;
              complementTotal += cPrice;
              const cPriceText = cPrice > 0 ? ` +R$ ${cPrice.toFixed(2)}` : '';
              text += `   + ${cName}${cPriceText}\n`;
            }
          });
        }
        
        // Subtotal = (item price + complement total) * quantity
        const itemSubtotal = (parseFloat(item.price) + complementTotal) * item.quantity;
        text += `   Subtotal: R$ ${itemSubtotal.toFixed(2)}\n`;
      }
      text += '\n';
    });
  }
  
  text += '================================\n';
  
  if (order.payments && order.payments.length > 0) {
    text += 'PAGAMENTO:\n';
    order.payments.forEach((payment, index) => {
      if (index > 0) text += '--------------------------------\n';
      text += `Metodo: ${getPaymentMethodText(payment.method)}\n`;
      text += `Valor: R$ ${parseFloat(payment.amount).toFixed(2)}\n`;
      if (payment.change_for) {
        const change = parseFloat(payment.change_for) - parseFloat(payment.amount);
        text += `Troco para: R$ ${parseFloat(payment.change_for).toFixed(2)}\n`;
        text += `Troco: R$ ${change.toFixed(2)}\n`;
      }
    });
    text += '================================\n';
  }
  
  text += `TOTAL DO PEDIDO: R$ ${parseFloat(order.total).toFixed(2)}\n`;
  
  if (order.observation) {
    text += '\n';
    text += 'OBSERVACOES:\n';
    text += order.observation + '\n';
  }
  
  // NOTE: Suppressing any duplicate item observations fields that might exist
  // Item observations should only appear within each item in the ITENS DO PEDIDO section
  // Common fields that might contain duplicate item observations:
  // - order.item_observations
  // - order.observacoes_dos_itens  
  // - order.itemObservations
  // These are intentionally NOT processed to avoid duplication
  
  text += '\n';
  text += '   Obrigado pela preferencia!\n';
  text += '      www.linkeats.com\n';
  text += '\n';
  text += '\n';
  text += '\n';
  text += '\n';
  
  return text;
}

// Print order function
// Returns { success, mode: 'simulation'|'printer', message }
async function printOrder(order) {
  if (!printerProcess || !printerReady) {
    console.log('=== SIMULAÇÃO DE IMPRESSÃO ===');
    console.log(formatOrderText(order));
    console.log('=== FIM DA SIMULAÇÃO ===');
    return { success: true, mode: 'simulation', message: 'Sem impressora conectada — enviado para fila de simulação' };
  }

  try {
    const text = formatOrderText(order);
    const response = await sendPrinterCommand({
      action: 'print',
      text: text,
      printer: selectedPrinter || undefined,
      font_size: 'medium'
    });

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

// WebSocket connection with join-printer
function connectWebSocket() {
  if (isConnecting) return;
  if (!kdsToken || !companyId) {
    console.log('⚠️ Cannot connect: missing token or companyId');
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

    // Join the printer room - this is what receives new-order and print-order events
    try {
      socket.send(JSON.stringify({
        type: 'join-printer',
        payload: { companyId }
      }));
      console.log(`🖨️ Joining printer room for company: ${companyId}`);
    } catch (e) {
      console.error('❌ Failed to send join-printer:', e.message);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('websocket-status', { connected: true });
    }
  });

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 WS message:', data.type);

      if (data.type === 'joined-printer') {
        console.log('✅ Joined printer room for company:', data.payload.companyId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('websocket-status', { connected: true });
        }
      } else if (data.type === 'new-order') {
        console.log('🔔 New order received:', data.payload?.id);
        // Always show in UI list - print-order event handles actual printing
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-order', data.payload);
        }
      } else if (data.type === 'print-order') {
        const orderId = data.payload?.id;
        console.log('🖨️ Print order event received:', orderId);
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
    if (kdsToken && companyId) {
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

// Connect using KDS token (generated via /auth/kds-token in the dashboard)
ipcMain.handle('connect-token', async (event, token) => {
  try {
    console.log('🔑 Attempting to connect with token:', token.substring(0, 20) + '...');
    const payload = decodeJwtPayload(token);
    console.log('🔍 Decoded payload:', payload);
    
    if (!payload) {
      console.log('❌ Token decode failed');
      return { success: false, error: 'Token inválido' };
    }
    if (!payload.company_id) {
      console.log('❌ Missing company_id');
      return { success: false, error: 'Token não contém company_id. Use o token KDS gerado no painel.' };
    }
    if (payload.device !== 'kds') {
      console.log('❌ Wrong device type:', payload.device);
      return { success: false, error: 'Token inválido. Use o token KDS gerado no painel (Configurações > Impressora).' };
    }

    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { success: false, error: 'Token expirado. Gere um novo token no painel.' };
    }

    kdsToken = token;
    companyId = payload.company_id;

    // Persist token
    store.set('kdsToken', token);
    store.set('companyId', companyId);

    // Fetch company name for receipt header
    try {
      const res = await fetch(`${BACKEND_URL}/public/menu/company`, {
        headers: { 'company_id': companyId }
      });
      if (res.ok) {
        const data = await res.json();
        companyName = data.display_name || data.name || null;
        store.set('companyName', companyName);
      }
    } catch (e) {
      companyName = store.get('companyName', null);
    }

    // Connect WebSocket
    connectWebSocket();

    return { success: true, companyId };
  } catch (error) {
    console.error('connect-token error:', error);
    return { success: false, error: error.message || 'Erro ao conectar' };
  }
});

ipcMain.handle('disconnect-token', () => {
  kdsToken = null;
  companyId = null;
  store.delete('kdsToken');
  store.delete('companyId');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.terminate(); } catch {} ws = null; }
  return { success: true };
});

ipcMain.handle('get-stored-token', () => {
  companyName = store.get('companyName', null);
  return {
    token: store.get('kdsToken', ''),
    companyId: store.get('companyId', '')
  };
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
    const response = await sendPrinterCommand({
      action: 'test',
      date: new Date().toLocaleString('pt-BR')
    });
    
    if (response.success) {
      return { success: true, message: response.message || 'Teste impresso com sucesso' };
    } else {
      return { success: false, error: response.error };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// App events
app.whenReady().then(() => {
  console.log('App is ready, creating window...');
  createWindow();
  
  // Try to initialize printer, but don't block the app if it fails
  setTimeout(() => {
    initializePrinter();
  }, 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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
