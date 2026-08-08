// DOM Elements
const loginSection = document.getElementById('login-section');
const appSection = document.getElementById('app-section');
const loginStatus = document.getElementById('login-status');
const pairCodeLoginInput = document.getElementById('pair-code-login');
const deviceNameLoginInput = document.getElementById('device-name-login');
const pairLoginBtn = document.getElementById('pair-login-btn');
const reconnectDeviceBtn = document.getElementById('reconnect-device-btn');
const printerSelect = document.getElementById('printer-select');
const refreshPrintersBtn = document.getElementById('refresh-printers-btn');
const connectionIndicator = document.getElementById('connection-indicator');
const connectionText = document.getElementById('connection-text');
const autoPrintToggle = document.getElementById('auto-print-toggle');
const fontScaleSelect = document.getElementById('font-scale-select');
const fontScaleValue = document.getElementById('font-scale-value');
const printFontSampleBtn = document.getElementById('print-font-sample-btn');
const paperWidthSelect = document.getElementById('paper-width-select');
const ordersList = document.getElementById('orders-list');
const pendingCount = document.getElementById('pending-count');
const clearAllOrdersBtn = document.getElementById('clear-all-orders-btn');
const statusMessage = document.getElementById('status-message');
const lastActivity = document.getElementById('last-activity');
const orderModal = document.getElementById('order-modal');
const closeModal = document.getElementById('close-modal');
const modalBody = document.getElementById('modal-body');
const printModalOrder = document.getElementById('print-modal-order');
const dismissOrder = document.getElementById('dismiss-order');
const currentVersionEl = document.getElementById('current-version');
const availableVersionEl = document.getElementById('available-version');
const updateReleaseNotesEl = document.getElementById('update-release-notes');
const updateAvailableBox = document.getElementById('update-available-box');
const updateStatusText = document.getElementById('update-status-text');
const updateDownloadBtn = document.getElementById('update-download-btn');
const updateInstallBtn = document.getElementById('update-install-btn');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const updateProgressWrap = document.getElementById('update-progress-wrap');
const updateProgressFill = document.getElementById('update-progress-fill');
const updateProgressText = document.getElementById('update-progress-text');

// State
let pendingOrders = [];
let currentOrder = null;
let isConnected = false;
let isPaired = false;
let manualConnectAttempt = false;

function waitForConnection({ timeoutMs }) {
    return new Promise((resolve) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (isConnected) {
                clearInterval(timer);
                resolve(true);
                return;
            }
            if (Date.now() - start >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, 200);
    });
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    // Register UI handlers first so pairing works even if printer init is slow/fails
    setupEventListeners();
    setupUpdateListeners();
    await tryAutoConnect();
    await loadAutoPrintStatus();
    await loadFontSize();
    await loadPaperWidth();
    await initializeUpdatePanel();
    // Printer list is optional — never block pairing/socket connect on it
    loadPrinters().catch((error) => {
        console.error('Error loading printers:', error);
    });
});

// Restore state on startup and auto-reconnect when already paired
async function tryAutoConnect() {
    try {
        const info = await window.electronAPI.getStoredDeviceInfo();
        isPaired = Boolean(info && info.paired);
        if (!isPaired) {
            showLoginScreen();
            return;
        }

        showApp();
        updateConnectionStatus(false);
        showStatus('Reconectando automaticamente...', 'info');

        const result = await window.electronAPI.connectStoredDevice();
        if (result && result.success) {
            const connected = await waitForConnection({ timeoutMs: 8000 });
            if (connected) {
                showStatus('Conectado. Ouvindo pedidos...', 'success');
                return;
            }
        }

        // Keep pairing saved — user can retry with Conectar
        updateConnectionStatus(false);
        showStatus('Desconectado. Tentaremos de novo ou clique em Conectar.', 'error');
    } catch (error) {
        console.error('Auto-connect error:', error);
        showLoginScreen();
    }
}

// Load and populate printers list
async function loadPrinters() {
    if (refreshPrintersBtn) {
        refreshPrintersBtn.disabled = true;
        refreshPrintersBtn.textContent = 'Atualizando...';
    }
    try {
        showStatus('Buscando impressoras...', 'info');
        const [printersRes, selectedRes] = await Promise.all([
            window.electronAPI.listPrinters(),
            window.electronAPI.getSelectedPrinter()
        ]);
        const printers = printersRes.printers || [];
        const selected = selectedRes.printer || '';

        // Keep the default option, repopulate the rest
        printerSelect.innerHTML = '<option value="">-- Padrão do sistema --</option>';
        printers.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === selected) opt.selected = true;
            printerSelect.appendChild(opt);
        });

        if (printers.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Nenhuma impressora encontrada';
            opt.disabled = true;
            printerSelect.appendChild(opt);
            showStatus(
                printersRes.success === false
                    ? 'Não foi possível listar impressoras (verifique o Python).'
                    : 'Nenhuma impressora encontrada no sistema.',
                'error'
            );
        } else {
            showStatus(`${printers.length} impressora(s) encontrada(s)`, 'success');
        }
    } catch (error) {
        console.error('Error loading printers:', error);
        showStatus(`Erro ao listar impressoras: ${error.message}`, 'error');
    } finally {
        if (refreshPrintersBtn) {
            refreshPrintersBtn.disabled = false;
            refreshPrintersBtn.textContent = 'Atualizar Impressoras';
        }
    }
}

// Load auto-print status
async function loadAutoPrintStatus() {
    try {
        const enabled = await window.electronAPI.getAutoPrintStatus();
        autoPrintToggle.checked = enabled;
    } catch (error) {
        console.error('Error loading auto-print status:', error);
    }
}

async function loadFontSize() {
    try {
        const data = await window.electronAPI.getFontSize();
        if (fontScaleSelect && data?.font_scale) {
            fontScaleSelect.value = String(data.font_scale);
        }
        updateFontScaleLabel(data);
        if (paperWidthSelect && data?.paper_width) {
            paperWidthSelect.value = data.paper_width;
        }
    } catch (error) {
        console.error('Error loading font size:', error);
    }
}

const FONT_SCALE_LABELS = {
    1: 'Muito pequena',
    2: 'Pequena',
    3: 'Compacta',
    4: 'Normal',
    5: 'Média',
    6: 'Média+',
    7: 'Grande',
    8: 'Muito grande',
};

function updateFontScaleLabel(data) {
    if (!fontScaleValue) return;
    const scale = Number(data?.font_scale || fontScaleSelect?.value || 4);
    const label = data?.label || FONT_SCALE_LABELS[scale] || 'Normal';
    fontScaleValue.textContent = label;
}

async function loadPaperWidth() {
    if (!paperWidthSelect) return;
    try {
        const data = await window.electronAPI.getPaperWidth();
        if (data?.paper_width) {
            paperWidthSelect.value = data.paper_width;
        }
    } catch (error) {
        console.error('Error loading paper width:', error);
    }
}

function showApp() {
    loginSection.classList.add('hidden');
    appSection.classList.remove('hidden');
}

function showLoginScreen() {
    appSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
}

function handleAccessRevoked(message) {
    manualConnectAttempt = false;
    isPaired = false;
    isConnected = false;
    pendingOrders = [];
    updateOrdersList();
    updateConnectionStatus(false);
    if (pairCodeLoginInput) pairCodeLoginInput.value = '';
    showLoginScreen();
    showLoginStatus(
        message || 'Acesso revogado. Gere um novo QR Code para vincular.',
        'error'
    );
}

// Setup event listeners
function setupEventListeners() {
    // Pairing (login screen)
    pairLoginBtn.addEventListener('click', handlePairLogin);
    pairCodeLoginInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handlePairLogin();
        }
    });

    // Reconnect device (settings panel)
    if (reconnectDeviceBtn) {
        reconnectDeviceBtn.addEventListener('click', handleReconnect);
    }

    // Printer selection
    printerSelect.addEventListener('change', async () => {
        const name = printerSelect.value || null;
        await window.electronAPI.setPrinter(name);
        showStatus(name ? `Impressora selecionada: ${name}` : 'Usando impressora padrão do sistema', 'success');
    });
    refreshPrintersBtn.addEventListener('click', loadPrinters);

    if (fontScaleSelect) {
        fontScaleSelect.addEventListener('change', async () => {
            const scale = Number(fontScaleSelect.value);
            const result = await window.electronAPI.setFontSize(scale);
            if (result?.font_scale) {
                fontScaleSelect.value = String(result.font_scale);
            }
            updateFontScaleLabel(result);
            showStatus(`Fonte: ${result.label || FONT_SCALE_LABELS[scale]}`, 'success');
        });
    }

    if (printFontSampleBtn) {
        printFontSampleBtn.addEventListener('click', async () => {
            printFontSampleBtn.disabled = true;
            try {
                const result = await window.electronAPI.printFontSample();
                showStatus(result.message || 'Amostra enviada para impressão', result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('Erro ao imprimir amostra de fonte', 'error');
            } finally {
                printFontSampleBtn.disabled = false;
            }
        });
    }

    if (paperWidthSelect) {
        paperWidthSelect.addEventListener('change', async () => {
            const width = paperWidthSelect.value;
            await window.electronAPI.setPaperWidth(width);
            showStatus(`Papel: ${width === '80mm' ? '80mm' : '58mm'}`, 'success');
        });
    }

    // Auto-print toggle
    autoPrintToggle.addEventListener('change', handleAutoPrintToggle);

    if (clearAllOrdersBtn) {
        clearAllOrdersBtn.addEventListener('click', handleClearAllOrders);
    }

    // Modal
    closeModal.addEventListener('click', closeOrderModal);
    printModalOrder.addEventListener('click', handlePrintModalOrder);
    dismissOrder.addEventListener('click', handleDismissOrder);

    // Click outside modal to close
    orderModal.addEventListener('click', (e) => {
        if (e.target === orderModal) {
            closeOrderModal();
        }
    });

    // WebSocket event listeners
    window.electronAPI.onWebSocketStatus((event, data) => {
        updateConnectionStatus(data.connected);
    });

    window.electronAPI.onDeviceAccessRevoked((event, data) => {
        handleAccessRevoked(data?.message);
    });

    window.electronAPI.onWebSocketError((event, error) => {
        showStatus(`Erro de conexão: ${error}`, 'error');
        const message = String(error || '').toLowerCase();
        if (
            message.includes('revog') ||
            message.includes('inválid') ||
            message.includes('invalido') ||
            message.includes('unauthorized') ||
            message.includes('não autoriz') ||
            message.includes('nao autoriz')
        ) {
            window.electronAPI.disconnectDevice().finally(() => {
                handleAccessRevoked('Acesso revogado. Gere um novo QR Code para vincular.');
            });
        }
    });

    window.electronAPI.onNewOrder((event, order) => {
        handleNewOrder(order);
    });

    window.electronAPI.onPrintResult((event, result) => {
        handlePrintResult(result);
    });
}

// Handle pair code claim (login screen)
async function handlePairLogin() {
    const code = pairCodeLoginInput.value.trim();
    const deviceName = deviceNameLoginInput ? deviceNameLoginInput.value.trim() : '';
    if (!code) {
        showLoginStatus('Digite o código de vinculação no campo acima', 'error');
        return;
    }

    pairLoginBtn.disabled = true;
    pairLoginBtn.textContent = 'Vinculando...';
    manualConnectAttempt = true;

    try {
        const result = await window.electronAPI.claimPairCode(code, deviceName);

        if (result.success) {
            isPaired = true;
            showLoginStatus('Código aceito. Conectando socket...', 'info');
            const connected = await waitForConnection({ timeoutMs: 8000 });
            if (connected) {
                manualConnectAttempt = false;
                showLoginStatus('Vinculado e conectado!', 'success');
                setTimeout(() => {
                    showApp();
                    showStatus('Conectado. Ouvindo pedidos...', 'success');
                }, 400);
            } else {
                manualConnectAttempt = false;
                showApp();
                updateConnectionStatus(false);
                showStatus('Vinculado, mas o socket não conectou. Clique em Conectar.', 'error');
                showLoginStatus('Vinculado, mas sem conexão WebSocket. Tente Conectar.', 'error');
            }
        } else {
            manualConnectAttempt = false;
            showLoginStatus(`Erro: ${result.error}`, 'error');
        }
    } catch (error) {
        manualConnectAttempt = false;
        showLoginStatus(`Erro: ${error.message}`, 'error');
    } finally {
        pairLoginBtn.disabled = false;
        pairLoginBtn.textContent = 'Vincular e Conectar';
    }
}

async function handleReconnect() {
    try {
        const info = await window.electronAPI.getStoredDeviceInfo();
        isPaired = Boolean(info && info.paired);
        if (!isPaired) {
            showLoginScreen();
            showLoginStatus('Gere um QR Code no painel para vincular.', 'info');
            return;
        }
        manualConnectAttempt = true;
        showStatus('Reconectando...', 'info');
        const result = await window.electronAPI.connectStoredDevice();
        if (result && result.success) {
            const connected = await waitForConnection({ timeoutMs: 6000 });
            if (connected) {
                manualConnectAttempt = false;
                return;
            }
        }

        await window.electronAPI.disconnectDevice();
        manualConnectAttempt = false;
        isPaired = false;
        showLoginScreen();
        showLoginStatus('Não foi possível conectar. Gere um novo QR Code para vincular.', 'error');
    } catch (error) {
        manualConnectAttempt = false;
        showStatus(`Erro ao reconectar: ${error.message}`, 'error');
    }
}

// Handle disconnect device
async function handleDisconnect() {
    await window.electronAPI.disconnectDevice();
    isPaired = false;
    pendingOrders = [];
    updateOrdersList();
    updateConnectionStatus(false);
    showLoginScreen();
    if (pairCodeLoginInput) pairCodeLoginInput.value = '';
    if (deviceNameLoginInput) deviceNameLoginInput.value = '';
    showLoginStatus('Desvinculado. Gere um novo QR Code no painel para vincular.', 'info');
}

// Handle auto-print toggle
async function handleAutoPrintToggle() {
    try {
        const enabled = autoPrintToggle.checked;
        await window.electronAPI.toggleAutoPrint(enabled);
        showStatus(`Impressão automática ${enabled ? 'ativada' : 'desativada'}`, 'success');
    } catch (error) {
        showStatus(`Erro ao alterar configuração: ${error.message}`, 'error');
        autoPrintToggle.checked = !autoPrintToggle.checked; // Revert
    }
}

// Handle new order
function handleNewOrder(order) {
    // Always add to pending list so user can see it
    const existingIndex = pendingOrders.findIndex(o => o.id === order.id);
    if (existingIndex === -1) {
        pendingOrders.unshift(order);
    } else {
        pendingOrders.splice(existingIndex, 1);
        pendingOrders.unshift(order);
    }
    updateOrdersList();
    updateLastActivity();
    if (order?.kind === 'tab_print') {
        showStatus(`Comanda recebida para impressão: mesa ${order.table_name || '-'}`, 'info');
    } else {
        showStatus(`Novo pedido recebido: #${order.id?.substring(0, 8)}`, 'info');
    }
}

// Handle print result
function handlePrintResult(result) {
    const { orderId, success, mode, message, auto } = result;

    if (success) {
        const modeLabel = mode === 'simulation'
            ? '(fila de simulação — sem impressora)'
            : '(enviado para a impressora)';
        if (auto) {
            showStatus(`Pedido #${orderId?.substring(0,8)} na fila de impressão ${modeLabel}`, 'success');
        } else {
            showStatus(`Pedido #${orderId?.substring(0,8)} na fila de impressão ${modeLabel}`, 'success');
            pendingOrders = pendingOrders.filter(order => order.id !== orderId);
            updateOrdersList();
        }
    } else {
        showStatus(`Erro ao imprimir pedido #${orderId?.substring(0,8)}: ${message || 'erro desconhecido'}`, 'error');
    }

    updateLastActivity();
}

// Update connection status
function updateConnectionStatus(connected) {
    isConnected = connected;
    connectionIndicator.classList.toggle('connected', connected);
    connectionText.textContent = connected ? 'Conectado' : 'Desconectado';
    if (reconnectDeviceBtn) {
        reconnectDeviceBtn.classList.toggle('hidden', connected || !isPaired);
    }
    
    if (connected) {
        showStatus('Conectado ao WebSocket. Aguardando pedidos...', 'success');
    } else {
        showStatus('Desconectado do WebSocket', 'error');
    }
}

// Update orders list
function updateOrdersList() {
    pendingCount.textContent = pendingOrders.length;
    if (clearAllOrdersBtn) {
        clearAllOrdersBtn.classList.toggle('hidden', pendingOrders.length === 0);
    }
    
    if (pendingOrders.length === 0) {
        ordersList.innerHTML = '<div class="no-orders"><p>Nenhum pedido pendente</p></div>';
        return;
    }
    
    ordersList.innerHTML = pendingOrders.map(order => createOrderElement(order)).join('');
    
    // Add click listeners to order items
    document.querySelectorAll('.order-item').forEach(item => {
        item.addEventListener('click', () => {
            const orderId = item.dataset.orderId;
            const order = pendingOrders.find(o => o.id == orderId);
            if (order) {
                showOrderModal(order);
            }
        });
    });
    
    // Add click listeners to action buttons
    document.querySelectorAll('.print-order-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const orderId = btn.dataset.orderId;
            const order = pendingOrders.find(o => o.id == orderId);
            if (order) {
                await printOrder(order);
            }
        });
    });
    
    document.querySelectorAll('.dismiss-order-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const orderId = btn.dataset.orderId;
            dismissOrderById(orderId);
        });
    });
}

// Create order element
function createOrderElement(order) {
    const isTabPrint = order?.kind === 'tab_print';
    const createdAt = new Date(order.created_at);
    const timeStr = createdAt.toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    const itemsCount = order.items ? order.items.length : 0;
    const itemsText = itemsCount === 1 ? '1 item' : `${itemsCount} itens`;
    const tabOrdersCount = Array.isArray(order.orders) ? order.orders.length : 0;
    const secondaryLine = isTabPrint
        ? `${tabOrdersCount} pedido(s) • Total: R$ ${parseFloat(order.total || 0).toFixed(2)}`
        : `${itemsText} • Total: R$ ${parseFloat(order.total || 0).toFixed(2)}`;
    const title = isTabPrint ? `Comanda Mesa ${order.table_name || '-'}` : (order.customer_name || 'Cliente não informado');
    const idLabel = isTabPrint ? `COMANDA ${order.tab_id || '-'}` : `#${order.id}`;
    
    return `
        <div class="order-item" data-order-id="${order.id}">
            <div class="order-header">
                <span class="order-id">${idLabel}</span>
                <span class="order-time">${timeStr}</span>
            </div>
            <div class="order-customer">
                <strong>${title}</strong>
            </div>
            <div class="order-items">
                ${secondaryLine}
            </div>
            <div class="order-actions">
                <button class="btn-primary print-order-btn" data-order-id="${order.id}">
                    Imprimir
                </button>
                <button class="btn-secondary dismiss-order-btn" data-order-id="${order.id}">
                    Dispensar
                </button>
            </div>
        </div>
    `;
}

// Show order modal
function showOrderModal(order) {
    currentOrder = order;
    modalBody.innerHTML = createOrderDetailHTML(order);
    orderModal.classList.remove('hidden');
}

// Close order modal
function closeOrderModal() {
    orderModal.classList.add('hidden');
    currentOrder = null;
}

// Create order detail HTML
function createOrderDetailHTML(order) {
    const isTabPrint = order?.kind === 'tab_print';
    const createdAt = new Date(order.created_at);
    const dateStr = createdAt.toLocaleString('pt-BR');

    if (isTabPrint) {
        const orders = Array.isArray(order.orders) ? order.orders : [];
        const ordersHtml = orders.map((o, idx) => {
            const itemCount = Array.isArray(o.items) ? o.items.length : 0;
            return `
                <div class="order-item-detail">
                    <div class="item-name">${idx + 1}. Pedido #${(o.id || '').substring(0, 8)} (${itemCount} item(ns))</div>
                    <div class="item-price">R$ ${parseFloat(o.total || 0).toFixed(2)}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="order-detail-section">
                <h4>Comanda para Impressão</h4>
                <p><strong>Comanda:</strong> ${order.tab_id || '-'}</p>
                <p><strong>Mesa:</strong> ${order.table_name || '-'}</p>
                <p><strong>Data:</strong> ${dateStr}</p>
                <p><strong>Pedidos:</strong> ${orders.length}</p>
                <p><strong>Total:</strong> R$ ${parseFloat(order.total || 0).toFixed(2)}</p>
            </div>
            <div class="order-detail-section">
                <h4>Pedidos vinculados</h4>
                <div class="order-items-detail">
                    ${ordersHtml || '<p>Nenhum pedido vinculado</p>'}
                </div>
            </div>
        `;
    }
    
    let itemsHTML = '';
    if (order.items && order.items.length > 0) {
        itemsHTML = order.items.map(item => {
            // Handle different possible data structures
            const productName = item.product?.name || item.Product?.name || item.name || 'Produto não identificado';
            const quantity = item.quantity || 1;
            const price = item.price || 0;
            const itemObsRaw = item.observation ?? item.observations ?? item.observacao ?? item.notes ?? item.obs ?? '';
            const itemObs = typeof itemObsRaw === 'string' ? itemObsRaw.trim() : String(itemObsRaw || '').trim();
            
            return `
                <div class="order-item-detail">
                    <div class="item-name">${quantity}x ${productName}</div>
                    ${price ? `<div class="item-price">R$ ${parseFloat(price).toFixed(2)}</div>` : ''}
                    ${itemObs ? `<div class="item-obs">Obs: ${itemObs}</div>` : ''}
                </div>
            `;
        }).join('');
    }
    
    return `
        <div class="order-detail-section">
            <h4>Informações do Pedido</h4>
            <p><strong>Número:</strong> #${order.id}</p>
            <p><strong>Data:</strong> ${dateStr}</p>
            <p><strong>Cliente:</strong> ${order.customer_name || 'Não informado'}</p>
            <p><strong>Telefone:</strong> ${order.phone || 'Não informado'}</p>
            ${order.total ? `<p><strong>Total:</strong> R$ ${parseFloat(order.total).toFixed(2)}</p>` : ''}
        </div>
        
        ${order.items && order.items.length > 0 ? `
            <div class="order-detail-section">
                <h4>Itens do Pedido</h4>
                <div class="order-items-detail">
                    ${itemsHTML}
                </div>
            </div>
        ` : ''}
        
        ${order.delivery_address ? `
            <div class="order-detail-section">
                <h4>Endereço de Entrega</h4>
                <p>${order.delivery_address}</p>
            </div>
        ` : ''}
        
        ${(order.observation || order.observations) ? `
            <div class="order-detail-section">
                <h4>Observações</h4>
                <p>${order.observation || order.observations}</p>
            </div>
        ` : ''}
    `;
}

// Handle print modal order
async function handlePrintModalOrder() {
    if (currentOrder) {
        await printOrder(currentOrder);
        closeOrderModal();
    }
}

// Handle dismiss order
function handleDismissOrder() {
    if (currentOrder) {
        dismissOrderById(currentOrder.id);
        closeOrderModal();
    }
}

// Print order (manual, from button click)
async function printOrder(order) {
    try {
        const result = await window.electronAPI.printOrder(order);

        if (result.success) {
            const modeLabel = result.mode === 'simulation'
                ? '(fila de simulação — sem impressora)'
                : '(enviado para a impressora)';
            if (order?.kind === 'tab_print') {
                showStatus(`Comanda ${order.tab_id || '-'} na fila de impressão ${modeLabel}`, 'success');
            } else {
                showStatus(`Pedido #${order.id.substring(0,8)} na fila de impressão ${modeLabel}`, 'success');
            }
            pendingOrders = pendingOrders.filter(o => o.id !== order.id);
            updateOrdersList();
        } else {
            if (order?.kind === 'tab_print') {
                showStatus(`Erro ao imprimir comanda ${order.tab_id || '-'}: ${result.message || 'erro desconhecido'}`, 'error');
            } else {
                showStatus(`Erro ao imprimir pedido #${order.id.substring(0,8)}: ${result.message || 'erro desconhecido'}`, 'error');
            }
        }
    } catch (error) {
        showStatus(`Erro ao imprimir: ${error.message}`, 'error');
    }

    updateLastActivity();
}

// Dismiss order by ID
function dismissOrderById(orderId) {
    pendingOrders = pendingOrders.filter(order => order.id != orderId);
    updateOrdersList();
    showStatus(`Pedido #${orderId} dispensado`, 'info');
}

function handleClearAllOrders() {
    if (pendingOrders.length === 0) return;
    const shouldClear = window.confirm('Deseja limpar todos os pedidos pendentes?');
    if (!shouldClear) return;
    pendingOrders = [];
    updateOrdersList();
    showStatus('Todos os pedidos pendentes foram removidos da lista', 'info');
}

// Show login status
function showLoginStatus(message, type) {
    loginStatus.textContent = message;
    loginStatus.className = `status-message ${type}`;
    loginStatus.style.display = 'block';
    
    setTimeout(() => {
        if (type !== 'success') {
            loginStatus.style.display = 'none';
        }
    }, 5000);
}

// Show status message
function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = type;
    
    // Auto-hide after 5 seconds for non-error messages
    if (type !== 'error') {
        setTimeout(() => {
            if (statusMessage.textContent === message) {
                statusMessage.textContent = 'Aguardando pedidos...';
                statusMessage.className = '';
            }
        }, 5000);
    }
}

// Update last activity
function updateLastActivity() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('pt-BR');
    lastActivity.textContent = `Última atividade: ${timeStr}`;
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setUpdateProgress(percent) {
    if (!updateProgressWrap || !updateProgressFill || !updateProgressText) return;
    updateProgressWrap.classList.remove('hidden');
    updateProgressFill.style.width = `${percent}%`;
    updateProgressText.textContent = `${percent}%`;
}

function resetUpdateDownloadUi() {
    if (updateProgressWrap) updateProgressWrap.classList.add('hidden');
    if (updateProgressFill) updateProgressFill.style.width = '0%';
    if (updateProgressText) updateProgressText.textContent = '0%';
    if (updateDownloadBtn) {
        updateDownloadBtn.disabled = false;
        updateDownloadBtn.textContent = 'Baixar atualização';
    }
    if (updateInstallBtn) updateInstallBtn.classList.add('hidden');
}

async function initializeUpdatePanel() {
    if (!currentVersionEl) return;
    try {
        const version = await window.electronAPI.getAppVersion();
        currentVersionEl.textContent = version || '—';
        if (updateStatusText) {
            updateStatusText.textContent = 'Verificando atualizações...';
        }
        await window.electronAPI.checkForUpdates();
    } catch (error) {
        if (updateStatusText) {
            updateStatusText.textContent = 'Não foi possível verificar atualizações';
        }
    }
}

function setupUpdateListeners() {
    if (!window.electronAPI) return;

    window.electronAPI.onUpdateAvailable((_event, data) => {
        if (currentVersionEl) currentVersionEl.textContent = data.currentVersion || '—';
        if (availableVersionEl) availableVersionEl.textContent = data.version || '—';
        if (updateReleaseNotesEl) {
            const notes = data.releaseNotes ? String(data.releaseNotes).trim() : '';
            updateReleaseNotesEl.textContent = notes || 'Nova versão disponível.';
        }
        if (updateAvailableBox) updateAvailableBox.classList.remove('hidden');
        if (updateStatusText) {
            const sizeLabel = data.fileSize ? ` (${formatFileSize(data.fileSize)})` : '';
            updateStatusText.textContent = `Atualização disponível${sizeLabel}`;
        }
        resetUpdateDownloadUi();
    });

    window.electronAPI.onUpdateNotAvailable((_event, data) => {
        if (currentVersionEl) currentVersionEl.textContent = data.currentVersion || '—';
        if (updateAvailableBox) updateAvailableBox.classList.add('hidden');
        if (updateStatusText) {
            updateStatusText.textContent = data.message || 'Você está na versão mais recente';
        }
    });

    window.electronAPI.onUpdateDownloadProgress((_event, data) => {
        setUpdateProgress(Number(data.percent || 0));
        if (updateDownloadBtn) {
            updateDownloadBtn.disabled = true;
            updateDownloadBtn.textContent = 'Baixando...';
        }
    });

    window.electronAPI.onUpdateDownloaded((_event, data) => {
        setUpdateProgress(100);
        if (updateDownloadBtn) {
            updateDownloadBtn.disabled = true;
            updateDownloadBtn.textContent = 'Download concluído';
        }
        if (updateInstallBtn) updateInstallBtn.classList.remove('hidden');
        if (updateStatusText) {
            updateStatusText.textContent = `Versão ${data.version} pronta para instalar`;
        }
    });

    window.electronAPI.onUpdateError((_event, data) => {
        resetUpdateDownloadUi();
        if (updateStatusText) {
            updateStatusText.textContent = data.message || 'Erro na atualização';
        }
    });

    if (checkUpdatesBtn) {
        checkUpdatesBtn.addEventListener('click', async () => {
            if (updateStatusText) updateStatusText.textContent = 'Verificando atualizações...';
            resetUpdateDownloadUi();
            await window.electronAPI.checkForUpdates();
        });
    }

    if (updateDownloadBtn) {
        updateDownloadBtn.addEventListener('click', async () => {
            resetUpdateDownloadUi();
            if (updateStatusText) updateStatusText.textContent = 'Baixando atualização...';
            await window.electronAPI.downloadUpdate();
        });
    }

    if (updateInstallBtn) {
        updateInstallBtn.addEventListener('click', async () => {
            if (updateStatusText) updateStatusText.textContent = 'Instalando e reiniciando...';
            await window.electronAPI.installUpdate();
        });
    }
}
