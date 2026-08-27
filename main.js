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
  buildScaleWeighReceipt,
  documentToPlainText,
  normalizeFontScale,
  getFontScaleLabel,
  DEFAULT_FONT_SCALE,
} = require('./printFormat');
const { ScaleService } = require('./scale/ScaleService');
const {
  normalizePrinterRouting,
  splitOrderPrintJobs,
  splitTabPrintJobs,
  resolvePrintOptionsForPrinter,
  filterJobsForAutoPrint,
} = require('./printerRouting');
const {
  normalizeAutoPrintFilters,
  shouldAutoPrintOrder,
  DEFAULT_AUTO_PRINT_FILTERS,
} = require('./autoPrintFilters');

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
let autoPrintFilters = normalizeAutoPrintFilters(store.get('autoPrintFilters', DEFAULT_AUTO_PRINT_FILTERS));

function getAutoPrintFilters() {
  return normalizeAutoPrintFilters(autoPrintFilters);
}

function persistAutoPrintFilters(filters) {
  autoPrintFilters = normalizeAutoPrintFilters(filters);
  store.set('autoPrintFilters', autoPrintFilters);
  return autoPrintFilters;
}
let deviceToken = store.get('deviceToken', null);
let deviceId = store.get('deviceId', null);
let companyId = store.get('companyId', null);
let companyName = store.get('companyName', null);
let printerReady = false;
let reconnectTimer = null;
let isConnecting = false;
let selectedPrinter = store.get('selectedPrinter', null);
let printerRouting = normalizePrinterRouting({
  defaultPrinter: store.get('selectedPrinter', null),
  routes: store.get('printerRoutes', []),
}, {
  fontScale: normalizeFontScale(store.get('fontScale', store.get('fontSize', DEFAULT_FONT_SCALE))),
  paperWidth: store.get('paperWidth', '58mm') === '80mm' ? '80mm' : '58mm',
});
if (!printerRouting.defaultPrinter && selectedPrinter) {
  printerRouting.defaultPrinter = selectedPrinter;
}
let fontScale = normalizeFontScale(store.get('fontScale', store.get('fontSize', DEFAULT_FONT_SCALE)));
let paperWidth = store.get('paperWidth', '58mm') === '80mm' ? '80mm' : '58mm';
const recentlyPrinted = new Set(); // deduplication guard
const scaleService = new ScaleService();
const savedScaleProtocol = store.get('scaleProtocol', 'toledo');
scaleService.protocolId = savedScaleProtocol || 'toledo';
scaleService.baudRate = Number(store.get('scaleBaudRate', 2400)) || 2400;
scaleService.portPath = store.get('scalePortPath', null);
scaleService.pricePerKg = Number(store.get('scalePricePerKg', 0)) || 0;

function broadcastScale(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

scaleService.on('weight', (reading) => broadcastScale('scale-weight', reading));
scaleService.on('status', (status) => broadcastScale('scale-status', status));

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, 'public', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.ico'),
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

function getRoutingDefaults() {
  return getPrintOptions();
}

function getPrinterRouting() {
  return normalizePrinterRouting({
    defaultPrinter: printerRouting.defaultPrinter || selectedPrinter || null,
    routes: printerRouting.routes || [],
  }, getRoutingDefaults());
}

function persistPrinterRouting(nextRouting) {
  printerRouting = normalizePrinterRouting(nextRouting, getRoutingDefaults());
  selectedPrinter = printerRouting.defaultPrinter || null;
  store.set('printerRoutes', printerRouting.routes);
  store.set('selectedPrinter', selectedPrinter);
  return printerRouting;
}

function buildReceiptForOrder(order, job = {}) {
  const options = {
    paperWidth: job.paperWidth || paperWidth,
    fontScale: job.fontScale != null ? job.fontScale : fontScale,
    items: job.order?.items,
    includePayment: job.includePayment,
    includeClient: job.includeClient,
    routeLabel: job.routeLabel,
    itemFilter: job.itemFilter,
  };

  if (order?.kind === 'tab_print') {
    return buildTabReceipt(job.tabData || order, companyName, options);
  }
  return buildOrderReceipt(job.order || order, companyName, options);
}

function buildPrinterCommandPayload(extra = {}) {
  const routing = getPrinterRouting();
  return {
    font_scale: fontScale,
    paper_width: paperWidth,
    printer: extra.printer || routing.defaultPrinter || selectedPrinter || undefined,
    // Logo removida; cupom em imagem (GDI) para controle da fonte em todos os tamanhos
    ...extra,
  };
}

async function sendReceiptToPrinter(receipt, printerName, printOptions = null) {
  const opts = printOptions || resolvePrintOptionsForPrinter(
    printerName,
    getPrinterRouting(),
    getRoutingDefaults()
  );
  const response = await sendPrinterCommand(buildPrinterCommandPayload({
    action: 'print',
    receipt,
    text: documentToPlainText(receipt),
    printer: printerName || undefined,
    font_scale: opts.fontScale,
    paper_width: opts.paperWidth,
  }));

  if (response.success) {
    return { success: true, mode: 'printer', message: response.message || 'Enviado para a impressora' };
  }
  return { success: false, mode: 'printer', message: response.error || 'Falha ao imprimir' };
}

async function sendPaperCut(printerName) {
  if (!printerProcess || !printerReady || !printerName) {
    return { success: false, mode: 'skipped', message: 'Corte indisponível sem impressora conectada' };
  }

  try {
    const response = await sendPrinterCommand(buildPrinterCommandPayload({
      action: 'cut',
      printer: printerName,
    }));
    if (response.success) {
      return { success: true, mode: 'printer', message: response.message || 'Corte enviado' };
    }
    return { success: false, mode: 'printer', message: response.error || 'Falha ao cortar papel' };
  } catch (error) {
    console.warn('Paper cut failed:', error.message);
    return { success: false, mode: 'printer', message: error.message || 'Falha ao cortar papel' };
  }
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
    const result = await printOrder(payload, { auto: true });
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

async function printFiscalDocument(payload = {}) {
  const base64 = String(payload?.base64 || '').trim();
  const title = String(payload?.title || 'Cupom fiscal');
  const mimeType = String(payload?.mimeType || '').toLowerCase();

  if (!base64) {
    return { success: false, mode: 'error', message: 'Cupom fiscal vazio' };
  }

  const routing = getPrinterRouting();
  const defaults = getRoutingDefaults();
  const printerName = routing.defaultPrinter || store.get('selectedPrinter') || undefined;
  const fiscalPaperWidth = payload?.paper_width || payload?.paperWidth || defaults.paperWidth || paperWidth;
  const sanitized = base64.replace(/\s/g, '');
  const buffer = Buffer.from(sanitized, 'base64');
  const isPdf = mimeType.includes('pdf') || sanitized.startsWith('JVBERi0');
  const printOptions = { paperWidth: fiscalPaperWidth, isPdf, rasterize: true };

  if (isPdf) {
    const tmpPath = path.join(app.getPath('temp'), `fiscal-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const fileUrl = `file://${tmpPath.replace(/\\/g, '/')}`;
    const result = await printFileWithHiddenWindow(fileUrl, printerName, title, () => {
      try { fs.unlinkSync(tmpPath); } catch {}
    }, printOptions);
    if (result.success && printerName) {
      await sendPaperCut(printerName);
    }
    return result;
  }

  const html = wrapFiscalHtmlForThermal(buffer.toString('utf-8'), fiscalPaperWidth);
  const tmpHtmlPath = path.join(app.getPath('temp'), `fiscal-${Date.now()}.html`);
  fs.writeFileSync(tmpHtmlPath, html, 'utf-8');
  const fileUrl = `file://${tmpHtmlPath.replace(/\\/g, '/')}`;
  const result = await printFileWithHiddenWindow(fileUrl, printerName, title, () => {
    try { fs.unlinkSync(tmpHtmlPath); } catch {}
  }, printOptions);
  if (result.success && printerName) {
    await sendPaperCut(printerName);
  }
  return result;
}

function getThermalPrintConfig(preferredPaperWidth) {
  const resolved = preferredPaperWidth === '80mm' ? '80mm' : '58mm';
  const is80 = resolved === '80mm';
  // Mesma largura em dots dos pedidos (printer.py obter_largura_imagem).
  const windowPx = is80 ? 576 : 384;
  return {
    paperWidth: resolved,
    widthMicrons: is80 ? 80000 : 58000,
    windowPx,
    cssWidth: `${windowPx}px`,
  };
}

function wrapFiscalHtmlForThermal(html, preferredPaperWidth) {
  const cfg = getThermalPrintConfig(preferredPaperWidth);
  // Tipografia próxima dos pedidos (font_scale alto). QR limitado para não “comer” a bobina.
  const thermalStyle = `
<style id="linkeats-fiscal-thermal">
  @page { size: ${cfg.paperWidth} auto; margin: 0; }
  html, body {
    margin: 0 !important;
    padding: 0 8px !important;
    box-sizing: border-box !important;
    width: ${cfg.cssWidth} !important;
    max-width: ${cfg.cssWidth} !important;
    background: #fff !important;
    color: #000 !important;
    font-family: Arial, Helvetica, sans-serif !important;
    font-size: 20px !important;
    line-height: 1.28 !important;
    border: none !important;
    outline: none !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  body, body *:not(img):not(svg):not(canvas):not(path) {
    font-family: Arial, Helvetica, sans-serif !important;
    font-size: 20px !important;
    line-height: 1.28 !important;
    color: #000 !important;
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
  }
  b, strong, h1, h2, h3, thead, th, .titulo, .title, .total, .totais {
    font-size: 22px !important;
    font-weight: 700 !important;
  }
  small, .tiny, .min, .obs, .observacao {
    font-size: 16px !important;
  }
  body > * {
    width: 100% !important;
    max-width: ${cfg.cssWidth} !important;
    box-sizing: border-box !important;
  }
  table {
    width: 100% !important;
    max-width: 100% !important;
    border-collapse: collapse !important;
    border: none !important;
  }
  td, th {
    font-size: 20px !important;
    padding: 2px 0 !important;
    border: none !important;
  }
  img, svg, canvas {
    max-width: 240px !important;
    width: auto !important;
    height: auto !important;
    display: block !important;
    margin: 8px auto !important;
  }
</style>`;

  const trimmed = String(html || '').trim();
  if (!trimmed) return `<!DOCTYPE html><html><head><meta charset="utf-8">${thermalStyle}</head><body></body></html>`;

  if (/<html[\s>]/i.test(trimmed)) {
    if (/<head[\s>]/i.test(trimmed)) {
      return trimmed.replace(/<head([^>]*)>/i, `<head$1>${thermalStyle}`);
    }
    return trimmed.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${thermalStyle}</head>`);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${thermalStyle}</head><body>${trimmed}</body></html>`;
}

async function boostFiscalDomForThermal(webContents, cfg, isPdf) {
  if (isPdf) {
    // PDF embutido: amplia a página; o recorte no Python encaixa na bobina.
    try {
      webContents.setZoomFactor(cfg.paperWidth === '80mm' ? 1.7 : 2.1);
    } catch (error) {
      console.warn('Fiscal PDF zoom failed:', error.message);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    return;
  }

  try {
    await webContents.executeJavaScript(`
(() => {
  const root = document.body || document.documentElement;
  if (!root) return false;

  document.querySelectorAll('[style]').forEach((el) => {
    try {
      el.style.removeProperty('font-size');
      el.style.removeProperty('font');
      el.style.removeProperty('line-height');
      el.style.removeProperty('transform');
      el.style.removeProperty('zoom');
      if (el.style.fontSize) el.style.fontSize = '';
    } catch {}
  });
  document.querySelectorAll('font[size]').forEach((el) => el.removeAttribute('size'));
  document.querySelectorAll('[face]').forEach((el) => el.removeAttribute('face'));

  document.querySelectorAll('img, canvas, svg').forEach((el) => {
    try {
      el.style.maxWidth = '240px';
      el.style.width = 'auto';
      el.style.height = 'auto';
      el.style.display = 'block';
      el.style.margin = '8px auto';
      el.removeAttribute('width');
      el.removeAttribute('height');
    } catch {}
  });

  const style = document.createElement('style');
  style.id = 'linkeats-fiscal-boost';
  style.textContent = \`
    html, body, body *:not(img):not(svg):not(canvas):not(path) {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 20px !important;
      line-height: 1.28 !important;
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
    }
    b, strong, h1, h2, h3, th {
      font-size: 22px !important;
    }
    table, td, th {
      border: none !important;
    }
    img, svg, canvas {
      max-width: 240px !important;
      width: auto !important;
      height: auto !important;
    }
  \`;
  (document.head || document.documentElement).appendChild(style);
  return true;
})();
    `, true);
  } catch (error) {
    console.warn('Fiscal DOM boost failed:', error.message);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
}

async function sendRasterImageToPrinter(pngBuffer, printerName, title, cfg) {
  const pngBase64 = pngBuffer.toString('base64');

  if (process.platform === 'win32' && printerProcess && printerReady) {
    try {
      const response = await sendPrinterCommand(buildPrinterCommandPayload({
        action: 'print_image',
        image_base64: pngBase64,
        printer: printerName || undefined,
        paper_width: cfg.paperWidth,
        font_scale: fontScale,
      }));
      if (response.success) {
        return {
          success: true,
          mode: 'printer',
          message: response.message || `${title} enviado para a impressora`,
        };
      }
      return {
        success: false,
        mode: 'printer',
        message: response.error || 'Falha ao imprimir cupom fiscal',
      };
    } catch (error) {
      console.warn('Fiscal raster via Python failed, falling back to Electron print:', error.message);
    }
  }

  const imgHtmlPath = path.join(app.getPath('temp'), `fiscal-img-${Date.now()}.html`);
  const imgHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${cfg.paperWidth} auto; margin: 0; }
  html, body { margin: 0; padding: 0; width: ${cfg.cssWidth}; background: #fff; }
  img { width: 100%; max-width: ${cfg.cssWidth}; height: auto; display: block; }
</style></head>
<body><img src="data:image/png;base64,${pngBase64}" alt="Cupom fiscal" /></body></html>`;
  fs.writeFileSync(imgHtmlPath, imgHtml, 'utf-8');

  const aspectHeightMicrons = Math.min(
    Math.max(Math.round(cfg.widthMicrons * 2.5), 120000),
    2500000
  );

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: cfg.windowPx,
      height: 1200,
      webPreferences: { sandbox: true },
    });

    const finish = (result) => {
      try { if (!win.isDestroyed()) win.close(); } catch {}
      try { fs.unlinkSync(imgHtmlPath); } catch {}
      resolve(result);
    };

    win.webContents.on('did-fail-load', (_event, _code, description) => {
      finish({ success: false, mode: 'printer', message: description || 'Falha ao carregar cupom fiscal' });
    });

    win.webContents.on('did-finish-load', () => {
      win.webContents.print({
        silent: Boolean(printerName),
        deviceName: printerName,
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: {
          width: cfg.widthMicrons,
          height: aspectHeightMicrons,
        },
        scaleFactor: 100,
      }, (success, failureReason) => {
        finish({
          success: Boolean(success),
          mode: 'printer',
          message: success ? `${title} enviado para a impressora` : (failureReason || 'Falha ao imprimir cupom fiscal'),
        });
      });
    });

    win.loadFile(imgHtmlPath).catch((error) => {
      finish({ success: false, mode: 'printer', message: error.message || 'Falha ao abrir cupom fiscal' });
    });
  });
}

async function rasterizeFiscalDocument(url, cfg, isPdf) {
  const win = new BrowserWindow({
    show: false,
    width: cfg.windowPx,
    height: 1600,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true },
  });

  try {
    await win.loadURL(url);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, isPdf ? 1200 : 350));
    await boostFiscalDomForThermal(win.webContents, cfg, isPdf);

    const contentHeight = await win.webContents.executeJavaScript(`
      Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
        320
      )
    `, true);

    const targetHeight = Math.min(Math.max(Math.round(Number(contentHeight) || 800), 400), 12000);
    win.setContentSize(cfg.windowPx, targetHeight);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));

    const image = await win.webContents.capturePage();
    return image.toPNG();
  } finally {
    try { if (!win.isDestroyed()) win.close(); } catch {}
  }
}

function printFileWithHiddenWindow(url, printerName, title, onDone, options = {}) {
  const cfg = getThermalPrintConfig(options.paperWidth || paperWidth);
  const isPdf = Boolean(options.isPdf);

  if (options.rasterize) {
    return rasterizeFiscalDocument(url, cfg, isPdf)
      .then((pngBuffer) => sendRasterImageToPrinter(pngBuffer, printerName, title, cfg))
      .then((result) => {
        if (typeof onDone === 'function') onDone();
        return result;
      })
      .catch((error) => {
        if (typeof onDone === 'function') onDone();
        return {
          success: false,
          mode: 'printer',
          message: error.message || 'Falha ao preparar cupom fiscal',
        };
      });
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: cfg.windowPx,
      height: 1600,
      webPreferences: {
        offscreen: false,
        sandbox: true,
      },
    });

    const finish = (result) => {
      try {
        if (!win.isDestroyed()) win.close();
      } catch {}
      if (typeof onDone === 'function') onDone();
      resolve(result);
    };

    win.webContents.on('did-fail-load', (_event, _code, description) => {
      finish({ success: false, mode: 'printer', message: description || 'Falha ao carregar cupom fiscal' });
    });

    win.webContents.on('did-finish-load', async () => {
      // PDF/HTML da Brasil NFe precisa de um instante para layout antes de imprimir.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, isPdf ? 900 : 250));

      let pageHeightMicrons = isPdf ? 450000 : 320000;
      try {
        const heightPx = await win.webContents.executeJavaScript(`
          Math.max(
            document.body ? document.body.scrollHeight : 0,
            document.documentElement ? document.documentElement.scrollHeight : 0,
            320
          )
        `, true);
        // ~96dpi → microns (1px ≈ 264,58µm). Margem extra para não cortar o fim do cupom.
        pageHeightMicrons = Math.min(Math.max(Math.round(Number(heightPx) * 265) + 12000, 120000), 2500000);
      } catch (error) {
        console.warn('Fiscal print height estimate failed:', error.message);
      }

      win.webContents.print({
        silent: Boolean(printerName),
        deviceName: printerName,
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: {
          width: cfg.widthMicrons,
          height: pageHeightMicrons,
        },
        scaleFactor: 100,
      }, (success, failureReason) => {
        finish({
          success: Boolean(success),
          mode: 'printer',
          message: success ? `${title} enviado para a impressora` : (failureReason || 'Falha ao imprimir cupom fiscal'),
        });
      });
    });

    win.loadURL(url).catch((error) => {
      finish({ success: false, mode: 'printer', message: error.message || 'Falha ao abrir cupom fiscal' });
    });
  });
}

async function handlePrintFiscalEvent(payload) {
  try {
    const looksPdf = String(payload?.mimeType || '').toLowerCase().includes('pdf')
      || String(payload?.base64 || '').replace(/\s/g, '').startsWith('JVBERi0');
    console.log('🧾 Print fiscal event received:', payload?.id || payload?.title, looksPdf ? '(pdf)' : '(html)');
    const result = await printFiscalDocument(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-result', {
        orderId: payload?.id || 'fiscal-document',
        success: result.success,
        mode: result.mode,
        message: result.message,
        auto: false,
      });
    }
  } catch (error) {
    console.error('Error handling print-fiscal event:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-result', {
        orderId: payload?.id || 'fiscal-document',
        success: false,
        mode: 'error',
        message: error.message,
        auto: false,
      });
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

    // Em desenvolvimento: sempre printer.py (senão o bin/printer-win.exe fica desatualizado).
    // Empacotado: preferir printer-win.exe; fallback para Python se existir.
    const wantBundledExe = app.isPackaged && process.platform === 'win32';
    if (wantBundledExe) {
      const packagedExe = path.join(process.resourcesPath, 'bin', 'printer-win.exe');
      if (fs.existsSync(packagedExe)) {
        console.log(`Attempting to start bundled printer engine: ${packagedExe}`);
        printerProcess = spawn(packagedExe, [], { windowsHide: true });
      }
    }

    if (!printerProcess) {
      const pythonPath = resolvePythonCommand();
      if (!pythonPath) {
        if (process.platform === 'win32') {
          const devExe = path.join(__dirname, 'bin', 'printer-win.exe');
          if (fs.existsSync(devExe)) {
            console.log(`Python ausente — usando EXE local: ${devExe}`);
            printerProcess = spawn(devExe, [], { windowsHide: true });
          }
        }
        if (!printerProcess) {
          console.log('Python not found — running in simulation mode');
          printerReady = false;
          return false;
        }
      } else {
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
    const action = String(command?.action || '');
    // Cupom fiscal / bitmaps altos podem demorar mais que o timeout curto dos pedidos.
    const timeoutMs = (action === 'print_image' || action === 'print') ? 60000 : 15000;

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

    const tryParseResponse = (chunk) => {
      responseData += chunk;
      const lines = responseData.split(/\r?\n/);
      responseData = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          return JSON.parse(trimmed);
        } catch {
          // linha incompleta ou log misturado
        }
      }
      const leftover = responseData.trim();
      if (leftover.startsWith('{') && leftover.endsWith('}')) {
        try {
          const parsed = JSON.parse(leftover);
          responseData = '';
          return parsed;
        } catch {
          // ainda incompleto
        }
      }
      return null;
    };

    const dataHandler = (data) => {
      const response = tryParseResponse(data.toString());
      if (response) finish(resolve, response);
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
    }, timeoutMs);

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
async function printOrder(order, options = {}) {
  const routing = getPrinterRouting();
  const defaults = getRoutingDefaults();
  const auto = options.auto === true;
  let jobs = order?.kind === 'tab_print'
    ? splitTabPrintJobs(order, routing, defaults)
    : splitOrderPrintJobs(order, routing, defaults);

  if (auto) {
    if (!shouldAutoPrintOrder(order, getAutoPrintFilters())) {
      return {
        success: true,
        mode: 'skipped',
        message: 'Pedido não corresponde aos filtros de impressão automática',
      };
    }
    jobs = filterJobsForAutoPrint(jobs, routing, isAutoPrintEnabled);
    if (!jobs.length) {
      return {
        success: true,
        mode: 'skipped',
        message: 'Nenhuma impressora com impressão automática habilitada para este pedido',
      };
    }
  }

  // Evita via vazia na principal
  jobs = jobs.filter((job) => {
    if (order?.kind === 'tab_print') return true;
    return Array.isArray(job?.order?.items) ? job.order.items.length > 0 : true;
  });
  if (!jobs.length) {
    return {
      success: true,
      mode: 'skipped',
      message: 'Nenhum item para imprimir nas impressoras selecionadas',
    };
  }

  if (!printerProcess || !printerReady) {
    console.log('=== SIMULAÇÃO DE IMPRESSÃO ===');
    for (const job of jobs) {
      const target = job.printer || routing.defaultPrinter || 'padrão do sistema';
      const jobOptions = {
        paperWidth: job.paperWidth || defaults.paperWidth,
        fontScale: job.fontScale != null ? job.fontScale : defaults.fontScale,
      };
      console.log(`--- Via: ${target}${job.partial ? ' (parcial)' : ''} · fonte ${jobOptions.fontScale} · ${jobOptions.paperWidth} ---`);
      console.log(order?.kind === 'tab_print'
        ? formatTabText(job.tabData || order, companyName, {
          ...jobOptions,
          includePayment: job.includePayment,
          routeLabel: job.routeLabel,
          itemFilter: job.itemFilter,
        })
        : formatOrderText(job.order || order, companyName, {
          ...jobOptions,
          items: job.order?.items,
          includePayment: job.includePayment,
          includeClient: job.includeClient,
          routeLabel: job.routeLabel,
        }));
    }
    console.log('=== FIM DA SIMULAÇÃO ===');
    const count = jobs.length;
    return {
      success: true,
      mode: 'simulation',
      message: count > 1
        ? `${count} vias enviadas para simulação`
        : 'Sem impressora conectada — enviado para fila de simulação',
    };
  }

  try {
    const messages = [];
    for (const job of jobs) {
      const receipt = buildReceiptForOrder(order, job);
      const result = await sendReceiptToPrinter(
        receipt,
        job.printer || routing.defaultPrinter,
        {
          fontScale: job.fontScale != null ? job.fontScale : defaults.fontScale,
          paperWidth: job.paperWidth || defaults.paperWidth,
        }
      );
      if (!result.success) {
        return result;
      }
      messages.push(result.message);
    }

    const count = jobs.length;
    return {
      success: true,
      mode: 'printer',
      message: count > 1 ? `${count} vias impressas` : (messages[0] || 'Enviado para a impressora'),
    };
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
        if (!isAutoPrintEnabled && !(getPrinterRouting().routes || []).some((route) => route.autoPrint)) {
          console.log('⚠️ Auto-print disabled — skipping automatic print for:', orderId);
        } else if (!shouldAutoPrintOrder(data.payload, getAutoPrintFilters())) {
          console.log('⚠️ Auto-print filter skipped order:', orderId);
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
        if (!isAutoPrintEnabled && !(getPrinterRouting().routes || []).some((route) => route.autoPrint)) {
          console.log('⚠️ Auto-print disabled — skipping automatic tab print for:', tabPrintId);
        } else if (!shouldAutoPrintOrder(data.payload, getAutoPrintFilters())) {
          console.log('⚠️ Auto-print filter skipped tab print:', tabPrintId);
        } else {
          printOrder(data.payload, { auto: true }).then((result) => {
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
      } else if (data.type === 'print-fiscal') {
        handlePrintFiscalEvent(data.payload || {});
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

ipcMain.handle('get-auto-print-filters', () => {
  return getAutoPrintFilters();
});

ipcMain.handle('set-auto-print-filters', (event, filters) => {
  return { success: true, filters: persistAutoPrintFilters(filters) };
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
  persistPrinterRouting({
    ...getPrinterRouting(),
    defaultPrinter: printerName || null,
  });
  return { success: true };
});

ipcMain.handle('get-selected-printer', () => {
  const routing = getPrinterRouting();
  selectedPrinter = routing.defaultPrinter || null;
  return { printer: selectedPrinter };
});

ipcMain.handle('get-printer-routing', () => {
  return { success: true, routing: getPrinterRouting() };
});

ipcMain.handle('set-printer-routing', (_event, routing) => {
  persistPrinterRouting(routing || {});
  return { success: true, routing: getPrinterRouting() };
});

ipcMain.handle('list-menu-categories', async () => {
  const token = store.get('deviceToken', null) || deviceToken;
  if (!token) {
    return { success: false, message: 'Impressora não vinculada à empresa', categories: [] };
  }

  try {
    const response = await fetch(`${BACKEND_URL}/printer/categories`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        message: data?.message || 'Não foi possível carregar as categorias',
        categories: [],
      };
    }

    const rawCategories = Array.isArray(data?.categories)
      ? data.categories
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data)
            ? data
            : [];

    const categories = rawCategories
      .map((category) => {
        if (!category || typeof category !== 'object') return null;
        const id = String(category.id || category.category_id || '').trim();
        const name = String(category.name || category.title || category.label || '').trim();
        if (!id || !name) return null;
        return { id, name, order: Number(category.order ?? category.sort_order) || 0 };
      })
      .filter(Boolean)
      .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'pt-BR'));

    return { success: true, categories };
  } catch (error) {
    return {
      success: false,
      message: 'Não foi possível carregar as categorias',
      categories: [],
    };
  }
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

// --- Balança (serial real + auto-detecção) ---
ipcMain.handle('scale-get-status', () => {
  return { success: true, ...scaleService.getStatus() };
});

ipcMain.handle('scale-list-ports', async () => {
  const result = await scaleService.listPorts();
  return { success: !result.error, ...result };
});

ipcMain.handle('scale-connect', async (_event, options = {}) => {
  try {
    const status = await scaleService.connectAuto({
      path: options.path || undefined,
    });
    if (status.portPath) store.set('scalePortPath', status.portPath);
    if (status.baudRate) store.set('scaleBaudRate', status.baudRate);
    if (status.protocolId) store.set('scaleProtocol', status.protocolId);
    return { success: true, ...status };
  } catch (error) {
    return { success: false, error: error.message, ...scaleService.getStatus() };
  }
});

ipcMain.handle('scale-stop', () => {
  return { success: true, ...scaleService.stop() };
});

ipcMain.handle('scale-set-price', async (_event, price) => {
  try {
    const status = await scaleService.setPricePerKg(price, { send: true });
    store.set('scalePricePerKg', status.pricePerKg);
    return {
      ...status,
      success: Boolean(status.ack),
      appOk: true,
    };
  } catch (error) {
    return { success: false, appOk: false, error: error.message, ...scaleService.getStatus() };
  }
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

ipcMain.handle('print-scale-ticket', async (event, payload = {}) => {
  const status = scaleService.getStatus();
  const kg = Number(payload?.kg ?? status.kg);
  const pricePerKg = Number(payload?.pricePerKg ?? status.pricePerKg);
  const total = Number(payload?.total ?? status.total);
  if (!Number.isFinite(kg) || kg <= 0) {
    return { success: false, message: 'Nenhum peso válido para imprimir. Coloque o item na balança.' };
  }

  const scalePrinterName = payload?.printer
    || store.get('scalePrinter', null)
    || selectedPrinter
    || null;
  if (payload?.printer) {
    store.set('scalePrinter', payload.printer || null);
  }

  const printOptions = resolvePrintOptionsForPrinter(
    scalePrinterName,
    getPrinterRouting(),
    getRoutingDefaults()
  );

  const receipt = buildScaleWeighReceipt(
    {
      kg,
      pricePerKg: Number.isFinite(pricePerKg) ? pricePerKg : 0,
      total: Number.isFinite(total) ? total : kg * (Number.isFinite(pricePerKg) ? pricePerKg : 0),
      at: payload?.at || new Date().toISOString(),
    },
    companyName,
    printOptions
  );
  const text = documentToPlainText(receipt);

  if (!printerProcess || !printerReady) {
    const initialized = initializePrinter();
    if (!initialized) {
      console.log('=== CUPOM DE PESAGEM (SIMULAÇÃO) ===');
      console.log(text);
      console.log('=== FIM DA SIMULAÇÃO ===');
      return { success: true, mode: 'simulation', message: 'Cupom gerado em modo simulação (veja o console)' };
    }
  }

  try {
    const response = await sendPrinterCommand(buildPrinterCommandPayload({
      action: 'print',
      receipt,
      text,
      printer: scalePrinterName || undefined,
      font_scale: printOptions.fontScale,
      paper_width: printOptions.paperWidth,
    }));
    if (response.success) {
      return {
        success: true,
        mode: 'printer',
        message: response.message || `Pesagem enviada para ${scalePrinterName || 'impressora padrão'}`,
        printer: scalePrinterName,
      };
    }
    return { success: false, mode: 'printer', message: response.error || 'Falha ao imprimir pesagem' };
  } catch (error) {
    return { success: false, mode: 'printer', message: error.message };
  }
});

ipcMain.handle('get-scale-printer', () => {
  return { printer: store.get('scalePrinter', null) || null };
});

ipcMain.handle('set-scale-printer', (_event, printerName) => {
  const printer = printerName ? String(printerName) : null;
  store.set('scalePrinter', printer);
  return { success: true, printer };
});

ipcMain.handle('scale-activate-card', async (_event, payload = {}) => {
  const token = store.get('deviceToken', null) || deviceToken;
  if (!token) {
    return { success: false, message: 'Impressora não vinculada à empresa' };
  }

  const code = Number(payload?.code);
  const status = scaleService.getStatus();
  const kg = Number(payload?.kg ?? status.kg);
  const pricePerKg = Number(payload?.pricePerKg ?? status.pricePerKg);
  const total = Number(payload?.total ?? status.total);
  const stable = payload?.stable ?? status.stable;

  if (!Number.isInteger(code) || code < 1) {
    return { success: false, message: 'Informe o número do cartão' };
  }
  if (!Number.isFinite(kg) || kg <= 0) {
    return { success: false, message: 'Peso inválido. Coloque o item na balança.' };
  }
  if (!stable) {
    return { success: false, message: 'Aguarde o peso estabilizar' };
  }

  try {
    const response = await fetch(`${BACKEND_URL}/printer/tab-cards/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        code,
        weight_kg: kg,
        price_per_kg: Number.isFinite(pricePerKg) ? pricePerKg : 0,
        total: Number.isFinite(total) ? total : kg * (Number.isFinite(pricePerKg) ? pricePerKg : 0),
        stable: true,
        product_id: payload?.productId || payload?.product_id || undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, message: data?.message || 'Falha ao ativar cartão' };
    }

    return {
      success: true,
      message: data?.message || `Cartão ${String(code).padStart(3, '0')} ativado`,
      appended: Boolean(data?.appended),
      card: data.card,
      tab: data.tab,
    };
  } catch (error) {
    return { success: false, message: error.message || 'Erro ao ativar cartão' };
  }
});

function normalizeTabCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = Number(
    raw.code ?? raw.card_code ?? raw.number ?? raw.cardNumber ?? raw.nro ?? raw.nro_card
  );
  if (!Number.isInteger(code) || code < 1) return null;

  const statusRaw = String(raw.status ?? raw.state ?? raw.situation ?? '').trim().toLowerCase();
  const activeFlag =
    raw.active === true ||
    raw.is_active === true ||
    raw.isActive === true ||
    raw.in_use === true ||
    raw.occupied === true;

  const activeStatuses = new Set([
    'active',
    'ativado',
    'ativa',
    'opened',
    'open',
    'aberta',
    'aberto',
    'in_use',
    'em_uso',
    'busy',
    'occupied',
    'ocupado',
    'ocupada',
  ]);

  const inactiveStatuses = new Set([
    'inactive',
    'inativo',
    'inativa',
    'available',
    'disponivel',
    'disponível',
    'free',
    'idle',
    'closed',
    'fechada',
    'fechado',
    'pending',
    'pendente',
    '',
  ]);

  let active = activeFlag || activeStatuses.has(statusRaw);
  if (!activeFlag && inactiveStatuses.has(statusRaw)) active = false;

  const label =
    raw.name ||
    raw.label ||
    raw.title ||
    raw.customer_name ||
    raw.table_name ||
    null;

  const activatedAt = raw.activated_at || raw.activatedAt || null;
  const scaleProductName =
    raw.scale_product_name || raw.scaleProductName || raw.current_product_name || null;

  return {
    id: raw.id || null,
    code,
    codeLabel: String(code).padStart(3, '0'),
    active: Boolean(active),
    status: statusRaw || (active ? 'active' : 'available'),
    label: label ? String(label) : null,
    activated_at: activatedAt,
    scale_product_name: scaleProductName ? String(scaleProductName) : null,
  };
}

function extractTabCardsPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cards)) return data.cards;
  if (Array.isArray(data?.tab_cards)) return data.tab_cards;
  if (Array.isArray(data?.tabCards)) return data.tabCards;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

ipcMain.handle('scale-list-tab-cards', async (_event, payload = {}) => {
  const token = store.get('deviceToken', null) || deviceToken;
  if (!token) {
    return { success: false, message: 'Impressora não vinculada à empresa', cards: [] };
  }

  const query = String(payload?.q || '').trim();
  const params = new URLSearchParams();
  if (query) params.set('q', query);

  try {
    const response = await fetch(`${BACKEND_URL}/printer/tab-cards?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        message: data?.message || 'Não foi possível carregar os cartões',
        cards: [],
      };
    }

    const cards = extractTabCardsPayload(data)
      .map(normalizeTabCard)
      .filter(Boolean);

    cards.sort((a, b) => a.code - b.code);
    return {
      success: true,
      cards,
      message: cards.length ? null : 'Nenhum cartão disponível',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Não foi possível carregar os cartões',
      cards: [],
    };
  }
});

ipcMain.handle('scale-list-weighable-products', async () => {
  const token = store.get('deviceToken', null) || deviceToken;
  if (!token) {
    return { success: false, message: 'Impressora não vinculada à empresa', products: [] };
  }

  try {
    const response = await fetch(`${BACKEND_URL}/printer/weighable-products`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        message: data?.message || 'Não foi possível carregar os produtos',
        products: [],
      };
    }

    const rawProducts = Array.isArray(data?.products) ? data.products : [];
    const products = rawProducts
      .map((product) => {
        if (!product || typeof product !== 'object') return null;
        const id = String(product.id || '').trim();
        const name = String(product.name || '').trim();
        const pricePerKg = Number(product.price_per_kg ?? product.pricePerKg);
        if (!id || !name || !Number.isFinite(pricePerKg) || pricePerKg < 0) return null;
        return { id, name, price_per_kg: pricePerKg };
      })
      .filter(Boolean);

    return {
      success: true,
      products,
      message: products.length ? null : 'Nenhum produto pesável cadastrado',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Não foi possível carregar os produtos',
      products: [],
    };
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
  // Dev (npm start) também consulta a sandbox — útil para testar o endpoint/UI.
  // O fluxo completo (baixar + instalar .exe) só faz sentido no app instalado (build).
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
        fileSize: pendingUpdate.fileSize,
        packaged: app.isPackaged
      });

      return { available: true, update: pendingUpdate, packaged: app.isPackaged };
    }

    pendingUpdate = null;
    notifyRenderer('update-not-available', {
      currentVersion,
      version: remoteVersion || currentVersion,
      message: app.isPackaged
        ? 'Você está na versão mais recente'
        : `Dev: sem update (local ${currentVersion}, remoto ${remoteVersion || '—'})`
    });
    return { available: false, packaged: app.isPackaged };
  } catch (err) {
    if (!silent) {
      notifyRenderer('update-error', { message: err.message || 'Erro ao verificar atualizações' });
    }
    return { available: false, error: err.message, packaged: app.isPackaged };
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

  // Em npm start, instalar o Setup.exe abre o instalador real — ok para teste,
  // mas o fluxo oficial é: instalar um build antigo e atualizar nele.
  if (!app.isPackaged) {
    console.log('⚠️ Instalando update a partir do modo dev (teste). Preferível usar build instalado.');
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
