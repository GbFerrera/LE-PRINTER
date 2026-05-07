// DOM Elements
const loginSection = document.getElementById('login-section');
const appSection = document.getElementById('app-section');
const loginStatus = document.getElementById('login-status');
const kdsTokenLoginInput = document.getElementById('kds-token-login');
const connectTokenLoginBtn = document.getElementById('connect-token-login-btn');
const disconnectTokenBtn = document.getElementById('disconnect-token-btn');
const kdsStatus = document.getElementById('kds-status');
const printerSelect = document.getElementById('printer-select');
const refreshPrintersBtn = document.getElementById('refresh-printers-btn');
const logoutBtn = document.getElementById('logout-btn');
const connectionIndicator = document.getElementById('connection-indicator');
const connectionText = document.getElementById('connection-text');
const autoPrintToggle = document.getElementById('auto-print-toggle');
const testPrinterBtn = document.getElementById('test-printer-btn');
const ordersList = document.getElementById('orders-list');
const pendingCount = document.getElementById('pending-count');
const statusMessage = document.getElementById('status-message');
const lastActivity = document.getElementById('last-activity');
const orderModal = document.getElementById('order-modal');
const closeModal = document.getElementById('close-modal');
const modalBody = document.getElementById('modal-body');
const printModalOrder = document.getElementById('print-modal-order');
const dismissOrder = document.getElementById('dismiss-order');

// State
let pendingOrders = [];
let currentOrder = null;
let isConnected = false;

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    await tryAutoConnect();
    await loadAutoPrintStatus();
    await loadPrinters();
    setupEventListeners();
});

// Auto-connect with stored token on startup
async function tryAutoConnect() {
    try {
        const stored = await window.electronAPI.getStoredToken();
        if (stored.token) {
            const result = await window.electronAPI.connectToken(stored.token);
            if (result.success) {
                showApp();
                showKdsStatus('Token conectado. Ouvindo pedidos...', 'success');
                return;
            }
        }
    } catch (error) {
        console.error('Auto-connect error:', error);
    }
    showLoginScreen();
}

// Load and populate printers list
async function loadPrinters() {
    try {
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
        }
    } catch (error) {
        console.error('Error loading printers:', error);
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

function showApp() {
    loginSection.classList.add('hidden');
    appSection.classList.remove('hidden');
}

function showLoginScreen() {
    appSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
}

// Setup event listeners
function setupEventListeners() {
    // KDS token connect (login screen)
    connectTokenLoginBtn.addEventListener('click', handleConnectTokenLogin);
    kdsTokenLoginInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleConnectTokenLogin();
        }
    });

    // Disconnect / change token (settings panel)
    disconnectTokenBtn.addEventListener('click', handleDisconnect);

    // Printer selection
    printerSelect.addEventListener('change', async () => {
        const name = printerSelect.value || null;
        await window.electronAPI.setPrinter(name);
        showStatus(name ? `Impressora selecionada: ${name}` : 'Usando impressora padrão do sistema', 'success');
    });
    refreshPrintersBtn.addEventListener('click', loadPrinters);

    // Logout button (header)
    logoutBtn.addEventListener('click', handleDisconnect);

    // Auto-print toggle
    autoPrintToggle.addEventListener('change', handleAutoPrintToggle);

    // Test printer
    testPrinterBtn.addEventListener('click', handleTestPrinter);

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

    window.electronAPI.onWebSocketError((event, error) => {
        showStatus(`Erro de conexão: ${error}`, 'error');
    });

    window.electronAPI.onNewOrder((event, order) => {
        handleNewOrder(order);
    });

    window.electronAPI.onPrintResult((event, result) => {
        handlePrintResult(result);
    });
}

// Handle connect KDS token (login screen)
async function handleConnectTokenLogin() {
    const token = kdsTokenLoginInput.value.trim();
    if (!token) {
        showLoginStatus('Cole o token KDS no campo acima', 'error');
        return;
    }

    connectTokenLoginBtn.disabled = true;
    connectTokenLoginBtn.textContent = 'Conectando...';

    try {
        const result = await window.electronAPI.connectToken(token);
        console.log('🔗 Connect result:', result);

        if (result.success) {
            console.log('✅ Token connection successful');
            showLoginStatus('Conectado!', 'success');
            setTimeout(() => {
                console.log('🚀 Showing app...');
                showApp();
                showKdsStatus('Token conectado. Ouvindo pedidos...', 'success');
            }, 600);
        } else {
            console.log('❌ Token connection failed:', result.error);
            showLoginStatus(`Erro: ${result.error}`, 'error');
        }
    } catch (error) {
        console.log('💥 Exception during token connection:', error);
        showLoginStatus(`Erro: ${error.message}`, 'error');
    } finally {
        connectTokenLoginBtn.disabled = false;
        connectTokenLoginBtn.textContent = 'Conectar';
    }
}

// Handle disconnect / change token
async function handleDisconnect() {
    await window.electronAPI.disconnectToken();
    pendingOrders = [];
    updateOrdersList();
    updateConnectionStatus(false);
    showLoginScreen();
    if (kdsTokenLoginInput) kdsTokenLoginInput.value = '';
    showLoginStatus('Desconectado. Cole um novo token para continuar.', 'info');
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

// Handle test printer
async function handleTestPrinter() {
    testPrinterBtn.disabled = true;
    testPrinterBtn.textContent = 'Testando...';
    
    try {
        const result = await window.electronAPI.testPrinter();
        
        if (result.success) {
            const message = result.message || 'Teste de impressão enviado com sucesso!';
            showStatus(message, 'success');
        } else {
            showStatus(`Erro no teste: ${result.error}`, 'error');
        }
    } catch (error) {
        showStatus(`Erro no teste: ${error.message}`, 'error');
    } finally {
        testPrinterBtn.disabled = false;
        testPrinterBtn.textContent = 'Testar Impressora';
    }
}

// Handle new order
function handleNewOrder(order) {
    // Always add to pending list so user can see it
    const exists = pendingOrders.some(o => o.id === order.id);
    if (!exists) {
        pendingOrders.unshift(order);
        updateOrdersList();
    }
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
    
    if (connected) {
        showStatus('Conectado ao WebSocket. Aguardando pedidos...', 'success');
    } else {
        showStatus('Desconectado do WebSocket', 'error');
    }
}

// Update orders list
function updateOrdersList() {
    pendingCount.textContent = pendingOrders.length;
    
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
            
            return `
                <div class="order-item-detail">
                    <div class="item-name">${quantity}x ${productName}</div>
                    ${price ? `<div class="item-price">R$ ${parseFloat(price).toFixed(2)}</div>` : ''}
                    ${item.observations ? `<div class="item-obs">Obs: ${item.observations}</div>` : ''}
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
        
        ${order.observations ? `
            <div class="order-detail-section">
                <h4>Observações</h4>
                <p>${order.observations}</p>
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

// Show KDS token status (inside settings panel)
function showKdsStatus(message, type) {
    if (!kdsStatus) return;
    kdsStatus.textContent = message;
    kdsStatus.className = `kds-status-msg ${type}`;
    setTimeout(() => {
        if (kdsStatus.textContent === message) {
            kdsStatus.textContent = '';
            kdsStatus.className = 'kds-status';
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
