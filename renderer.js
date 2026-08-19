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
const testPrinterBtn = document.getElementById('test-printer-btn');
const openPrintConfigBtn = document.getElementById('open-print-config-btn');
const openScaleConfigBtn = document.getElementById('open-scale-config-btn');
const printConfigDrawer = document.getElementById('print-config-drawer');
const scaleConfigDrawer = document.getElementById('scale-config-drawer');
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
const headerUpdateBtn = document.getElementById('header-update-btn');
const scaleWeightDisplay = document.getElementById('scale-weight-display');
const scaleWeightValue = document.getElementById('scale-weight-value');
const scaleStableBadge = document.getElementById('scale-stable-badge');
const scaleModeLabel = document.getElementById('scale-mode-label');
const scalePortSelect = document.getElementById('scale-port-select');
const scaleRefreshPortsBtn = document.getElementById('scale-refresh-ports-btn');
const scaleConnectBtn = document.getElementById('scale-connect-btn');
const scaleStopBtn = document.getElementById('scale-stop-btn');
const scaleProtocolHint = document.getElementById('scale-protocol-hint');
const scaleDetectedInfo = document.getElementById('scale-detected-info');
const scalePriceInput = document.getElementById('scale-price-input');
const scaleSendPriceBtn = document.getElementById('scale-send-price-btn');
const scalePriceDisplay = document.getElementById('scale-price-display');
const scaleTotalDisplay = document.getElementById('scale-total-display');
const scalePrintBtn = document.getElementById('scale-print-btn');
const scalePrinterSelect = document.getElementById('scale-printer-select');
const scaleCardCodeInput = document.getElementById('scale-card-code-input');
const scaleActivateCardBtn = document.getElementById('scale-activate-card-btn');
const scaleCardResults = document.getElementById('scale-card-results');
const scaleCardRefreshBtn = document.getElementById('scale-card-refresh-btn');
const scaleCardHint = document.getElementById('scale-card-hint');
const scaleCardCombobox = document.getElementById('scale-card-combobox');
const scaleProductSelect = document.getElementById('scale-product-select');
const scaleProductHint = document.getElementById('scale-product-hint');
const printerRoutesList = document.getElementById('printer-routes-list');
const addPrinterRouteBtn = document.getElementById('add-printer-route-btn');
const refreshMenuCategoriesBtn = document.getElementById('refresh-menu-categories-btn');
let availablePrinters = [];
let menuCategories = [];
let menuCategoriesError = '';
let printerRouting = { defaultPrinter: null, routes: [] };
let lastScaleReading = { kg: 0, pricePerKg: 0, total: 0, stable: false };
let lastScalePortPath = '';
let scaleTabCards = [];
let scaleSelectedCardCode = null;
let scaleCardsLoading = false;
let scaleCardsSearchTimer = null;
let scaleCardActivating = false;
let scaleWeighableProducts = [];
let scaleSelectedProductId = '';
let scaleProductsLoading = false;
let scaleWeighingLoadToken = 0;
let pendingUpdateVersion = null;
let headerUpdatePhase = 'idle'; // idle | available | downloading | ready

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
    setupScaleListeners();
    setupAppTabs();
    await tryAutoConnect();
    await loadAutoPrintStatus();
    await loadFontSize();
    await loadPaperWidth();
    await loadScalePanel();
    await initializeUpdatePanel();
    // Printer list is optional — never block pairing/socket connect on it
    loadPrinters().catch((error) => {
        console.error('Error loading printers:', error);
    });
    loadPrinterRouting().catch((error) => {
        console.error('Error loading printer routing:', error);
    });
    loadMenuCategories().catch((error) => {
        console.error('Error loading menu categories:', error);
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
        availablePrinters = printers;

        // Keep the default option, repopulate the rest
        printerSelect.innerHTML = '<option value="">-- Padrão do sistema --</option>';
        printers.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === selected) opt.selected = true;
            printerSelect.appendChild(opt);
        });

        renderPrinterRoutes();
        await populateScalePrinterSelect(selected);

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
            refreshPrintersBtn.textContent = 'Atualizar';
        }
    }
}

function createRouteId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getAssignedCategoryIds(excludeRouteId = null) {
    const assigned = new Set();
    for (const route of printerRouting.routes || []) {
        if (excludeRouteId && route.id === excludeRouteId) continue;
        for (const categoryId of route.categoryIds || []) {
            assigned.add(String(categoryId));
        }
    }
    return assigned;
}

function buildPrinterOptions(selectedPrinterName = '') {
    const options = ['<option value="">-- Selecione a impressora --</option>'];
    for (const name of availablePrinters) {
        const selected = name === selectedPrinterName ? ' selected' : '';
        options.push(`<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`);
    }
    return options.join('');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadPrinterRouting() {
    if (!window.electronAPI.getPrinterRouting) return;
    const result = await window.electronAPI.getPrinterRouting();
    printerRouting = result?.routing || { defaultPrinter: null, routes: [] };
    if (printerSelect && printerRouting.defaultPrinter) {
        printerSelect.value = printerRouting.defaultPrinter;
    }
    renderPrinterRoutes();
}

function buildFontScaleOptions(selectedScale = 4) {
    const labels = {
        1: 'Muito pequena',
        2: 'Pequena',
        3: 'Compacta',
        4: 'Normal',
        5: 'Média',
        6: 'Média+',
        7: 'Grande',
        8: 'Muito grande',
    };
    return Object.entries(labels).map(([value, label]) => {
        const selected = String(selectedScale) === String(value) ? ' selected' : '';
        return `<option value="${value}"${selected}>${label}</option>`;
    }).join('');
}

function buildPaperWidthOptions(selectedWidth = '58mm') {
    const widths = [
        { value: '58mm', label: '58mm' },
        { value: '80mm', label: '80mm' },
    ];
    return widths.map(({ value, label }) => {
        const selected = selectedWidth === value ? ' selected' : '';
        return `<option value="${value}"${selected}>${label}</option>`;
    }).join('');
}

async function savePrinterRouting() {
    if (!window.electronAPI.setPrinterRouting) return;
    const payload = {
        defaultPrinter: printerSelect?.value || null,
        routes: (printerRouting.routes || []).map((route) => ({
            id: route.id,
            printer: route.printer || '',
            categoryIds: Array.isArray(route.categoryIds) ? route.categoryIds : [],
            fontScale: Number(route.fontScale) || 4,
            paperWidth: route.paperWidth === '80mm' ? '80mm' : '58mm',
            autoPrint: Boolean(route.autoPrint),
            alsoPrintOnMain: Boolean(route.alsoPrintOnMain),
        })),
    };
    const result = await window.electronAPI.setPrinterRouting(payload);
    printerRouting = result?.routing || payload;
}

async function loadMenuCategories() {
    if (!window.electronAPI.listMenuCategories) return;
    if (refreshMenuCategoriesBtn) {
        refreshMenuCategoriesBtn.disabled = true;
        refreshMenuCategoriesBtn.textContent = 'Atualizando categorias...';
    }
    try {
        const result = await window.electronAPI.listMenuCategories();
        menuCategories = result?.success ? (result.categories || []) : [];
        menuCategoriesError = result?.success
            ? ''
            : (result?.message || 'Não foi possível carregar as categorias');
        if (result?.success && !menuCategories.length) {
            menuCategoriesError = 'Nenhuma categoria encontrada no cardápio.';
        }
        renderPrinterRoutes();
    } catch (error) {
        menuCategories = [];
        menuCategoriesError = error?.message || 'Não foi possível carregar as categorias';
        renderPrinterRoutes();
    } finally {
        if (refreshMenuCategoriesBtn) {
            refreshMenuCategoriesBtn.disabled = false;
            refreshMenuCategoriesBtn.textContent = 'Atualizar categorias';
        }
    }
}

function renderPrinterRoutes() {
    if (!printerRoutesList) return;

    const routes = Array.isArray(printerRouting.routes) ? printerRouting.routes : [];
    if (!routes.length) {
        printerRoutesList.innerHTML = '<p class="printer-routes-empty">Nenhuma impressora extra configurada.</p>';
        return;
    }

    printerRoutesList.innerHTML = routes.map((route) => {
        const assignedElsewhere = getAssignedCategoryIds(route.id);
        let categoryChecks = '';
        if (menuCategories.length) {
            categoryChecks = menuCategories.map((category) => {
                const categoryId = String(category.id);
                const checked = (route.categoryIds || []).map(String).includes(categoryId) ? ' checked' : '';
                const disabled = assignedElsewhere.has(categoryId) ? ' disabled' : '';
                return `
                    <label class="printer-route-category${disabled ? ' is-disabled' : ''}">
                        <input type="checkbox" data-route-id="${escapeHtml(route.id)}" data-category-id="${escapeHtml(categoryId)}"${checked}${disabled}>
                        <span>${escapeHtml(category.name)}</span>
                    </label>
                `;
            }).join('');
        } else if (menuCategoriesError) {
            categoryChecks = `<p class="settings-help">${escapeHtml(menuCategoriesError)}</p>`;
        } else {
            categoryChecks = '<p class="settings-help">Conecte à empresa para carregar as categorias do cardápio.</p>';
        }

        const missingPrinter = !route.printer;
        const missingCategories = !(route.categoryIds || []).length;
        const draftHint = missingPrinter || missingCategories
            ? `<p class="settings-help">${missingPrinter ? 'Selecione a impressora. ' : ''}${missingCategories ? 'Marque ao menos uma categoria.' : ''}</p>`
            : '';

        return `
            <div class="printer-route-card" data-route-id="${escapeHtml(route.id)}">
                <div class="printer-route-header">
                    <strong>Impressora auxiliar</strong>
                    <button type="button" class="btn-link printer-route-remove" data-route-id="${escapeHtml(route.id)}">Remover</button>
                </div>
                <select class="printer-route-select" data-route-id="${escapeHtml(route.id)}">
                    ${buildPrinterOptions(route.printer || '')}
                </select>
                <div class="printer-route-print-options">
                    <div class="form-group">
                        <label>Fonte</label>
                        <select class="printer-route-font-select" data-route-id="${escapeHtml(route.id)}">
                            ${buildFontScaleOptions(route.fontScale || 4)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Papel</label>
                        <select class="printer-route-paper-select" data-route-id="${escapeHtml(route.id)}">
                            ${buildPaperWidthOptions(route.paperWidth || '58mm')}
                        </select>
                    </div>
                </div>
                <div class="printer-route-switches">
                    <label class="printer-route-switch">
                        <input type="checkbox" class="printer-route-auto-print" data-route-id="${escapeHtml(route.id)}"${route.autoPrint ? ' checked' : ''}>
                        <span>Impressão automática</span>
                    </label>
                    <label class="printer-route-switch">
                        <input type="checkbox" class="printer-route-print-on-main" data-route-id="${escapeHtml(route.id)}"${route.alsoPrintOnMain ? ' checked' : ''}>
                        <span>Também na principal</span>
                    </label>
                </div>
                <div class="printer-route-categories">${categoryChecks}</div>
                ${draftHint}
            </div>
        `;
    }).join('');

    printerRoutesList.querySelectorAll('.printer-route-select').forEach((select) => {
        select.addEventListener('change', async () => {
            const routeId = select.dataset.routeId;
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            route.printer = select.value || '';
            await savePrinterRouting();
            renderPrinterRoutes();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-font-select').forEach((select) => {
        select.addEventListener('change', async () => {
            const routeId = select.dataset.routeId;
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            route.fontScale = Number(select.value) || 4;
            await savePrinterRouting();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-paper-select').forEach((select) => {
        select.addEventListener('change', async () => {
            const routeId = select.dataset.routeId;
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            route.paperWidth = select.value === '80mm' ? '80mm' : '58mm';
            await savePrinterRouting();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-auto-print').forEach((input) => {
        input.addEventListener('change', async () => {
            const routeId = input.dataset.routeId;
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            route.autoPrint = Boolean(input.checked);
            await savePrinterRouting();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-print-on-main').forEach((input) => {
        input.addEventListener('change', async () => {
            const routeId = input.dataset.routeId;
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            route.alsoPrintOnMain = Boolean(input.checked);
            await savePrinterRouting();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-category input[type="checkbox"]').forEach((input) => {
        input.addEventListener('change', async () => {
            const routeId = input.dataset.routeId;
            const categoryId = String(input.dataset.categoryId || '');
            const route = printerRouting.routes.find((item) => item.id === routeId);
            if (!route) return;
            const ids = new Set((route.categoryIds || []).map(String));
            if (input.checked) ids.add(categoryId);
            else ids.delete(categoryId);
            route.categoryIds = Array.from(ids);
            await savePrinterRouting();
            renderPrinterRoutes();
        });
    });

    printerRoutesList.querySelectorAll('.printer-route-remove').forEach((button) => {
        button.addEventListener('click', async () => {
            const routeId = button.dataset.routeId;
            printerRouting.routes = (printerRouting.routes || []).filter((route) => route.id !== routeId);
            await savePrinterRouting();
            renderPrinterRoutes();
            showStatus('Impressora removida da configuração', 'success');
        });
    });
}

async function addPrinterRoute() {
    const defaultFont = Number(fontScaleSelect?.value) || 4;
    const defaultPaper = paperWidthSelect?.value === '80mm' ? '80mm' : '58mm';
    printerRouting.routes = Array.isArray(printerRouting.routes) ? printerRouting.routes : [];
    printerRouting.routes.push({
        id: createRouteId(),
        printer: '',
        categoryIds: [],
        fontScale: defaultFont,
        paperWidth: defaultPaper,
        autoPrint: false,
        alsoPrintOnMain: false,
    });
    await savePrinterRouting();
    renderPrinterRoutes();
    if (!menuCategories.length) {
        loadMenuCategories().catch(() => {});
    }
    showStatus('Nova impressora adicionada — selecione o equipamento, tamanho e categorias', 'success');
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

function formatScaleKg(kg) {
    const n = Number(kg);
    if (!Number.isFinite(n)) return '0,000';
    return n.toFixed(3).replace('.', ',');
}

function formatScaleMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'R$ 0,00';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatScaleCardActivatedAt(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function getScaleCardByCode(code) {
    const cardCode = Number(code);
    if (!Number.isInteger(cardCode) || cardCode < 1) return null;
    return scaleTabCards.find((card) => card.code === cardCode) || null;
}

function getSelectedScaleCard() {
    const code = getSelectedScaleCardCode();
    return code != null ? getScaleCardByCode(code) : null;
}

function getScaleCardOptionMeta(card) {
    if (!card?.active) return card?.label ? `<span>${card.label}</span>` : '';
    const since = formatScaleCardActivatedAt(card.activated_at);
    const parts = [];
    if (since) parts.push(`Ativo desde ${since}`);
    if (card.scale_product_name) parts.push(`Produto atual: ${card.scale_product_name}`);
    return `<span class="scale-card-option-meta">${parts.join(' · ')}</span>`;
}

function getScaleCardSelectionHint(card) {
    if (!card) return 'Digite para buscar, clique para selecionar e depois confirme.';
    const productName = scaleWeighableProducts.find((item) => item.id === scaleSelectedProductId)?.name;
    if (card.active) {
        const since = formatScaleCardActivatedAt(card.activated_at);
        let message = `Cartão ${card.codeLabel} já está ativo`;
        if (since) message += ` desde ${since}`;
        message += '. Você vai vincular';
        message += productName ? ` "${productName}"` : ' este produto';
        message += ' a este cartão.';
        return message;
    }
    return `Cartão ${card.codeLabel} selecionado. Clique em Ativar cartão.`;
}

function updateScaleCardActiveNotice(card) {
    const notice = document.getElementById('scale-card-active-notice');
    if (!notice) return;
    if (!card?.active) {
        notice.hidden = true;
        notice.textContent = '';
        return;
    }
    notice.hidden = false;
    notice.textContent = getScaleCardSelectionHint(card);
}

function updateScaleActionButtons() {
    const hasWeight = lastScaleReading.kg > 0;
    const code = getSelectedScaleCardCode();
    const hasValidCode = Number.isInteger(code) && code > 0;
    const selectedCard = hasValidCode ? getScaleCardByCode(code) : null;
    const needsProduct = scaleWeighableProducts.length > 0;
    const hasProduct = !needsProduct || Boolean(scaleSelectedProductId);
    const canActivate = hasWeight && lastScaleReading.stable && hasValidCode && hasProduct && isPaired;

    if (scalePrintBtn) {
        scalePrintBtn.disabled = !hasWeight;
    }
    if (scaleActivateCardBtn) {
        scaleActivateCardBtn.hidden = !hasValidCode;
        scaleActivateCardBtn.disabled = !canActivate || scaleCardActivating;
        scaleActivateCardBtn.textContent = selectedCard?.active ? 'Vincular produto' : 'Ativar cartão';
    }
    updateScaleCardActiveNotice(selectedCard);
}

function getSelectedScaleCardCode() {
    if (scaleSelectedCardCode != null) return scaleSelectedCardCode;
    const typed = String(scaleCardCodeInput?.value || '').trim();
    const code = Number(typed);
    return Number.isInteger(code) && code > 0 ? code : null;
}

function filterScaleTabCards(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return scaleTabCards
        .filter((card) => {
            const codeMatch = String(card.code).includes(q) || String(card.codeLabel).includes(q);
            const labelMatch = card.label ? String(card.label).toLowerCase().includes(q) : false;
            return codeMatch || labelMatch;
        })
        .slice(0, 30);
}

function hideScaleCardResults() {
    if (scaleCardResults) scaleCardResults.hidden = true;
}

function selectScaleCard(card) {
    if (!card) return;
    scaleSelectedCardCode = card.code;
    if (scaleCardCodeInput) {
        scaleCardCodeInput.value = card.codeLabel;
        scaleCardCodeInput.classList.add('is-selected');
        scaleCardCodeInput.classList.toggle('is-active-card', Boolean(card.active));
    }
    if (scaleCardResults) {
        scaleCardResults.querySelectorAll('.scale-card-option').forEach((el) => {
            el.classList.toggle('is-selected', el.dataset.code === String(card.code));
        });
    }
    if (scaleCardHint) {
        scaleCardHint.textContent = getScaleCardSelectionHint(card);
    }
    updateScaleActionButtons();
}

function clearScaleCardSelection() {
    scaleSelectedCardCode = null;
    if (scaleCardCodeInput) {
        scaleCardCodeInput.value = '';
        scaleCardCodeInput.classList.remove('is-selected');
        scaleCardCodeInput.classList.remove('is-active-card');
    }
    updateScaleCardActiveNotice(null);
    updateScaleActionButtons();
}

function setScaleWeighingBusy(busy) {
    if (scaleProductSelect) scaleProductSelect.disabled = busy || scaleProductsLoading;
    // Mantém o campo do cartão editável enquanto carrega listas.
    if (scaleCardCodeInput) scaleCardCodeInput.disabled = Boolean(scaleCardActivating);
    if (scaleCardRefreshBtn) {
        scaleCardRefreshBtn.disabled = busy;
        scaleCardRefreshBtn.classList.toggle('is-busy', busy);
    }
}

function syncScaleCardInputEnabled() {
    if (!scaleCardCodeInput) return;
    scaleCardCodeInput.disabled = Boolean(scaleCardActivating);
}

function renderScaleCardLoadingState(message = 'Buscando cartões...') {
    if (!scaleCardResults) return;
    scaleCardResults.innerHTML = '';
    const loadingOpt = document.createElement('div');
    loadingOpt.className = 'scale-card-option is-loading';
    loadingOpt.innerHTML = `<span class="scale-spinner"></span><span>${message}</span>`;
    scaleCardResults.appendChild(loadingOpt);
    scaleCardResults.hidden = false;
}

function renderScaleCardResults(query, { open = false } = {}) {
    if (!scaleCardResults) return;

    const q = String(query || '').trim();
    scaleCardResults.innerHTML = '';

    if (scaleCardsLoading && q && open) {
        renderScaleCardLoadingState('Buscando cartões...');
        return;
    }

    if (!q || !open) {
        hideScaleCardResults();
        if (scaleCardHint && !scaleCardsLoading && !scaleCardActivating) {
            scaleCardHint.textContent = 'Digite para buscar, clique para selecionar e depois ative.';
        }
        return;
    }

    const filtered = filterScaleTabCards(q);

    if (!scaleTabCards.length) {
        if (q && open) {
            scaleCardResults.hidden = false;
            const emptyOpt = document.createElement('div');
            emptyOpt.className = 'scale-card-option is-empty';
            emptyOpt.textContent = 'Nenhum cartão disponível';
            scaleCardResults.appendChild(emptyOpt);
        } else {
            hideScaleCardResults();
        }
        if (scaleCardHint) {
            scaleCardHint.textContent = 'Nenhum cartão cadastrado.';
        }
        return;
    }

    if (!filtered.length) {
        scaleCardResults.hidden = false;
        const emptyOpt = document.createElement('div');
        emptyOpt.className = 'scale-card-option is-empty';
        emptyOpt.textContent = 'Nenhum cartão encontrado';
        scaleCardResults.appendChild(emptyOpt);
        if (scaleCardHint) {
            scaleCardHint.textContent = 'Nenhum cartão encontrado.';
        }
        return;
    }

    filtered.forEach((card) => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'scale-card-option';
        if (card.active) opt.classList.add('is-active-card');
        opt.setAttribute('role', 'option');
        opt.dataset.code = String(card.code);
        opt.innerHTML = `<strong>${card.codeLabel}</strong>${getScaleCardOptionMeta(card)}`;
        if (Number(scaleSelectedCardCode) === card.code) {
            opt.classList.add('is-selected');
        }
        opt.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectScaleCard(card);
            hideScaleCardResults();
            scaleCardCodeInput?.focus();
        });
        scaleCardResults.appendChild(opt);
    });

    scaleCardResults.hidden = false;
    if (scaleCardHint) {
        scaleCardHint.textContent = 'Clique no cartão para selecionar.';
    }
}

async function activateScaleCardByCode(code) {
    if (!window.electronAPI.scaleActivateCard || scaleCardActivating) return;

    const cardCode = Number(code);
    if (!Number.isInteger(cardCode) || cardCode < 1) {
        showStatus('Informe um número de cartão válido', 'error');
        return;
    }

    const card = scaleTabCards.find((c) => c.code === cardCode);
    if (card) selectScaleCard(card);

    if (!isPaired) {
        showStatus('Impressora não vinculada à empresa', 'error');
        updateScaleActionButtons();
        return;
    }

    const kg = lastScaleReading.kg || 0;
    if (kg <= 0) {
        showStatus('Aguardando peso na balança', 'error');
        updateScaleActionButtons();
        return;
    }

    if (!lastScaleReading.stable) {
        showStatus('Aguarde o peso estabilizar', 'error');
        updateScaleActionButtons();
        return;
    }

    if (scaleWeighableProducts.length > 0 && !scaleSelectedProductId) {
        showStatus('Selecione o produto pesado', 'error');
        updateScaleActionButtons();
        return;
    }

    const priceFromInput = Number(String(scalePriceInput?.value || '0').replace(',', '.'));
    const pricePerKg = Number.isFinite(priceFromInput) && priceFromInput >= 0
        ? priceFromInput
        : lastScaleReading.pricePerKg;
    const total = kg * (Number.isFinite(pricePerKg) ? pricePerKg : 0);

    scaleCardActivating = true;
    syncScaleCardInputEnabled();
    const isActiveCard = Boolean(card?.active);
    const cardLabel = String(cardCode).padStart(3, '0');
    const productName =
        scaleWeighableProducts.find((item) => item.id === scaleSelectedProductId)?.name || '';
    if (scaleCardHint) {
        scaleCardHint.textContent = isActiveCard
            ? `Vinculando produto ao cartão ${cardLabel}...`
            : `Ativando cartão ${cardLabel}...`;
    }

    try {
        const result = await window.electronAPI.scaleActivateCard({
            code: cardCode,
            kg,
            pricePerKg,
            total,
            stable: lastScaleReading.stable,
            productId: scaleSelectedProductId || undefined,
        });
        if (result?.success) {
            const linkedProduct =
                Boolean(result.appended) ||
                isActiveCard ||
                Boolean(scaleSelectedProductId);
            const successMessage = linkedProduct
                ? productName
                    ? `Produto "${productName}" adicionado ao cartão ${cardLabel} com sucesso`
                    : `Produto adicionado ao cartão ${cardLabel} com sucesso`
                : result.message || `Cartão ${cardLabel} ativado com sucesso`;

            showToast(successMessage, 'success');
            showStatus(successMessage, 'success');
            clearScaleCardSelection();
            hideScaleCardResults();
            await loadScaleTabCards('');
        } else {
            const errorMessage = result?.message || 'Falha ao ativar cartão';
            showToast(errorMessage, 'error');
            showStatus(errorMessage, 'error');
            if (scaleCardHint) {
                scaleCardHint.textContent = `Cartão ${cardLabel} selecionado. Corrija e tente de novo.`;
            }
        }
    } catch (error) {
        const errorMessage = error?.message || 'Falha ao ativar cartão';
        showToast(errorMessage, 'error');
        showStatus(errorMessage, 'error');
        if (scaleCardHint) {
            scaleCardHint.textContent = `Cartão ${cardLabel} selecionado. Corrija e tente de novo.`;
        }
    } finally {
        scaleCardActivating = false;
        syncScaleCardInputEnabled();
        updateScaleActionButtons();
        const q = String(scaleCardCodeInput?.value || '').trim();
        if (q && (document.activeElement === scaleCardCodeInput || scaleSelectedCardCode != null)) {
            renderScaleCardResults(q, { open: true });
        }
    }
}

async function loadScaleTabCards(query = '', options = {}) {
    if (!window.electronAPI.scaleListTabCards) return;
    const silent = Boolean(options.silent);
    scaleCardsLoading = true;
    if (!silent && scaleCardRefreshBtn) scaleCardRefreshBtn.disabled = true;
    if (scaleCardHint) scaleCardHint.textContent = 'Carregando cartões...';
    const q = String(scaleCardCodeInput?.value || query || '').trim();
    if (q) renderScaleCardResults(q, { open: true });

    let result = null;
    try {
        result = await window.electronAPI.scaleListTabCards({ q: query });
        scaleTabCards = Array.isArray(result?.cards) ? result.cards : [];
    } catch (error) {
        scaleTabCards = [];
        if (scaleCardHint) {
            scaleCardHint.textContent = 'Não foi possível carregar os cartões.';
        }
    } finally {
        scaleCardsLoading = false;
        if (!silent && scaleCardRefreshBtn && !scaleProductsLoading) {
            scaleCardRefreshBtn.disabled = false;
        }
        syncScaleCardInputEnabled();

        const currentQuery = String(scaleCardCodeInput?.value || query || '').trim();
        if (currentQuery) {
            renderScaleCardResults(currentQuery, { open: document.activeElement === scaleCardCodeInput });
        } else {
            renderScaleCardResults('', { open: false });
            if (scaleCardHint && !scaleCardActivating) {
                scaleCardHint.textContent = result?.success === false && result?.message
                    ? 'Não foi possível carregar os cartões.'
                    : 'Digite para buscar, clique para selecionar e depois ative.';
            }
        }

        updateScaleActionButtons();
    }
}

function scheduleScaleCardSearch() {
    const q = String(scaleCardCodeInput?.value || '').trim();
    if (!q) {
        hideScaleCardResults();
        if (scaleCardHint && !scaleCardsLoading) {
            scaleCardHint.textContent = 'Digite para buscar, clique para selecionar e depois ative.';
        }
        return;
    }

    renderScaleCardLoadingState('Buscando cartões...');
    if (scaleCardsSearchTimer) clearTimeout(scaleCardsSearchTimer);
    scaleCardsSearchTimer = setTimeout(() => {
        loadScaleTabCards(q);
    }, 280);
}

async function loadWeighableProducts(options = {}) {
    if (!window.electronAPI.scaleListWeighableProducts) return;
    const silent = Boolean(options.silent);
    scaleProductsLoading = true;
    if (!silent) setScaleWeighingBusy(true);
    if (scaleProductSelect) {
        scaleProductSelect.disabled = true;
        scaleProductSelect.innerHTML = '<option value="">Carregando produtos...</option>';
    }
    if (scaleProductHint) scaleProductHint.textContent = 'Buscando produtos pesáveis...';

    try {
        const result = await window.electronAPI.scaleListWeighableProducts();
        scaleWeighableProducts = Array.isArray(result?.products) ? result.products : [];
        renderWeighableProducts();
        if (!result?.success && result?.message && scaleProductHint) {
            scaleProductHint.textContent = 'Não foi possível carregar os produtos.';
        }
    } catch (error) {
        scaleWeighableProducts = [];
        renderWeighableProducts();
        if (scaleProductHint) {
            scaleProductHint.textContent = 'Não foi possível carregar os produtos.';
        }
    } finally {
        scaleProductsLoading = false;
        if (!silent) {
            if (scaleProductSelect) scaleProductSelect.disabled = false;
            setScaleWeighingBusy(false);
        }
        updateScaleActionButtons();
    }
}

async function loadScaleWeighingData(query = '') {
    const token = ++scaleWeighingLoadToken;
    setScaleWeighingBusy(true);
    if (scaleProductHint) scaleProductHint.textContent = 'Buscando produtos pesáveis...';
    if (scaleCardHint) scaleCardHint.textContent = 'Buscando cartões...';

    try {
        await Promise.all([
            loadWeighableProducts({ silent: true }),
            loadScaleTabCards(query, { silent: true }),
        ]);
    } finally {
        if (token === scaleWeighingLoadToken) {
            if (scaleProductSelect) scaleProductSelect.disabled = false;
            syncScaleCardInputEnabled();
            setScaleWeighingBusy(false);
        }
    }
}

function applyScalePricing(data) {
    const price = Number(data?.pricePerKg);
    const total = Number(data?.total);
    const kg = Number(data?.kg ?? lastScaleReading.kg);
    if (Number.isFinite(price)) {
        lastScaleReading.pricePerKg = price;
    }
    if (Number.isFinite(kg)) {
        lastScaleReading.kg = kg;
    }
    const computed = Number.isFinite(total)
        ? total
        : (lastScaleReading.kg || 0) * (Number.isFinite(price) ? price : lastScaleReading.pricePerKg || 0);
    lastScaleReading.total = computed;
    if (scalePriceDisplay && Number.isFinite(price)) {
        scalePriceDisplay.textContent = formatScaleMoney(price);
    }
    if (scaleTotalDisplay) {
        scaleTotalDisplay.textContent = formatScaleMoney(computed);
    }
    if (scalePriceInput && Number.isFinite(price) && document.activeElement !== scalePriceInput) {
        scalePriceInput.value = price ? String(price) : '0';
    }
    updateScaleActionButtons();
}

function applyScaleReading(reading) {
    if (!reading) return;
    lastScaleReading.kg = Number(reading.kg) || 0;
    lastScaleReading.stable = reading.stable !== false;
    if (Number.isFinite(Number(reading.pricePerKg))) {
        lastScaleReading.pricePerKg = Number(reading.pricePerKg);
    }
    if (Number.isFinite(Number(reading.total))) {
        lastScaleReading.total = Number(reading.total);
    }
    if (scaleWeightValue) {
        scaleWeightValue.textContent = formatScaleKg(reading.kg);
    }
    if (scaleWeightDisplay) {
        scaleWeightDisplay.classList.toggle('is-unstable', reading.stable === false);
    }
    if (scaleStableBadge) {
        if (reading.stable) {
            scaleStableBadge.textContent = 'Estável';
            scaleStableBadge.className = 'scale-badge stable';
        } else {
            scaleStableBadge.textContent = 'Instável';
            scaleStableBadge.className = 'scale-badge unstable';
        }
    }
    applyScalePricing(reading);
}

function updateScaleDetectedInfo(status) {
    if (!scaleDetectedInfo) return;
    if (status?.mode === 'detecting') {
        scaleDetectedInfo.textContent = 'Detectando baud e protocolo...';
        return;
    }
    if (status?.running && status.portPath) {
        const proto = status.protocol?.name || status.protocolId || '—';
        scaleDetectedInfo.textContent = `${status.portPath} · ${status.baudRate} baud · ${proto}`;
        return;
    }
    scaleDetectedInfo.textContent = 'Baud e protocolo detectados ao conectar.';
}

function applyScaleStatus(status) {
    if (!status) return;
    if (status.portPath && (status.mode === 'serial' || status.running)) {
        lastScalePortPath = status.portPath;
        if (scalePortSelect && [...scalePortSelect.options].some((o) => o.value === status.portPath)) {
            scalePortSelect.value = status.portPath;
        }
    }
    if (scaleModeLabel) {
        if (status.mode === 'detecting') {
            scaleModeLabel.textContent = 'Detectando...';
        } else if (status.running && status.mode === 'serial') {
            scaleModeLabel.textContent = status.portPath || 'Conectada';
        } else {
            scaleModeLabel.textContent = 'Parada';
        }
    }
    const busy = Boolean(status.running) || status.mode === 'detecting';
    if (scaleConnectBtn) {
        scaleConnectBtn.disabled = busy;
        scaleConnectBtn.textContent = status.mode === 'detecting' ? 'Detectando...' : 'Conectar';
    }
    if (scaleStopBtn) scaleStopBtn.disabled = !status.running;
    if (scalePortSelect) scalePortSelect.disabled = busy;
    if (scaleSendPriceBtn) scaleSendPriceBtn.disabled = !status.running;
    if (scalePriceInput) scalePriceInput.disabled = false;
    updateScaleDetectedInfo(status);
    applyScalePricing(status);
    if (scaleProtocolHint) {
        if (status.lastError) {
            scaleProtocolHint.textContent = `Erro: ${status.lastError}`;
        } else if (status.running) {
            scaleProtocolHint.textContent = 'Lendo peso da balança. Coloque um item estável no prato.';
        } else {
            scaleProtocolHint.textContent = 'Conecte o cabo da balança e clique em Conectar.';
        }
    }
    if (status.kg != null) {
        applyScaleReading({ kg: status.kg, stable: status.stable });
    }
}

async function loadScalePorts(preferredPath) {
    if (!scalePortSelect || !window.electronAPI.scaleListPorts) return;
    try {
        const result = await window.electronAPI.scaleListPorts();
        const ports = result?.ports || [];
        const selected = preferredPath || lastScalePortPath || scalePortSelect.value || '';
        scalePortSelect.innerHTML = '<option value="">Automático</option>';
        ports.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.path;
            opt.textContent = p.friendlyName ? `${p.path} — ${p.friendlyName}` : p.path;
            scalePortSelect.appendChild(opt);
        });
        if (selected && [...scalePortSelect.options].some((o) => o.value === selected)) {
            scalePortSelect.value = selected;
            lastScalePortPath = selected;
        }
        if (!ports.length && scaleProtocolHint) {
            scaleProtocolHint.textContent = 'Nenhuma COM encontrada. Conecte o cabo USB da balança.';
        }
    } catch (error) {
        console.error('Error listing scale ports:', error);
    }
}

async function populateScalePrinterSelect(fallbackSelected = '') {
    if (!scalePrinterSelect) return;
    let preferred = '';
    try {
        if (window.electronAPI.getScalePrinter) {
            const result = await window.electronAPI.getScalePrinter();
            preferred = result?.printer || '';
        }
    } catch {}

    const current = preferred || scalePrinterSelect.value || fallbackSelected || '';
    scalePrinterSelect.innerHTML = '<option value="">Usar impressora padrão</option>';
    availablePrinters.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        scalePrinterSelect.appendChild(opt);
    });
    if (current && [...scalePrinterSelect.options].some((o) => o.value === current)) {
        scalePrinterSelect.value = current;
    }
}

async function ensureScaleAutoConnect() {
    if (!window.electronAPI.scaleConnect || !window.electronAPI.scaleGetStatus) return;
    try {
        await loadScalePorts(scalePortSelect?.value || lastScalePortPath);
        const status = await window.electronAPI.scaleGetStatus();
        applyScaleStatus(status);
        if (status?.running || status?.mode === 'detecting') {
            return status;
        }

        if (scaleConnectBtn) {
            scaleConnectBtn.disabled = true;
            scaleConnectBtn.textContent = 'Detectando...';
        }
        if (scaleProtocolHint) {
            scaleProtocolHint.textContent = 'Conectando balança automaticamente...';
        }
        showStatus('Conectando balança...', 'info');

        const result = await window.electronAPI.scaleConnect({
            path: scalePortSelect?.value || lastScalePortPath || undefined,
        });
        applyScaleStatus(result);
        if (result?.success && result.running) {
            showStatus(
                `Balança em ${result.portPath} @ ${result.baudRate} (${result.protocol?.name || result.protocolId})`,
                'success'
            );
        } else if (result?.error || result?.lastError) {
            showStatus(result.error || result.lastError, 'error');
        }
        return result;
    } catch (error) {
        console.error('Auto-connect scale error:', error);
        showStatus(error?.message || 'Falha ao conectar balança', 'error');
        return null;
    }
}

async function loadScalePanel() {
    if (!window.electronAPI.scaleGetStatus) return;
    try {
        const status = await window.electronAPI.scaleGetStatus();
        if (status?.portPath) lastScalePortPath = status.portPath;
        await loadScalePorts(lastScalePortPath);
        applyScaleStatus(status);
        await populateScalePrinterSelect(printerSelect?.value || '');
        await loadScaleWeighingData('');
        if (!status?.running) {
            await ensureScaleAutoConnect();
        }
    } catch (error) {
        console.error('Error loading scale panel:', error);
    }
}

function applySelectedWeighableProduct(productId) {
    scaleSelectedProductId = String(productId || '');
    const product = scaleWeighableProducts.find((item) => item.id === scaleSelectedProductId);
    if (!product) return;

    const pricePerKg = Number(product.price_per_kg);
    if (!Number.isFinite(pricePerKg) || pricePerKg < 0) return;

    lastScaleReading.pricePerKg = pricePerKg;
    if (scalePriceInput) scalePriceInput.value = String(pricePerKg);
    if (scalePriceDisplay) scalePriceDisplay.textContent = formatScaleMoney(pricePerKg);
    if (window.electronAPI.scaleSetPrice) {
        void window.electronAPI.scaleSetPrice(pricePerKg);
    }
    applyScalePricing({
        kg: lastScaleReading.kg,
        pricePerKg,
        total: lastScaleReading.kg * pricePerKg,
    });
}

function renderWeighableProducts() {
    if (!scaleProductSelect) return;
    const previous = scaleSelectedProductId;
    scaleProductSelect.innerHTML = '<option value="">Selecione o produto...</option>';
    scaleWeighableProducts.forEach((product) => {
        const opt = document.createElement('option');
        opt.value = product.id;
        opt.textContent = `${product.name} — ${formatScaleMoney(product.price_per_kg)}/kg`;
        scaleProductSelect.appendChild(opt);
    });

    if (previous && scaleWeighableProducts.some((item) => item.id === previous)) {
        scaleProductSelect.value = previous;
        applySelectedWeighableProduct(previous);
    } else if (scaleWeighableProducts.length > 0) {
        scaleProductSelect.value = scaleWeighableProducts[0].id;
        applySelectedWeighableProduct(scaleWeighableProducts[0].id);
    }

    if (scaleProductHint) {
        scaleProductHint.textContent = scaleWeighableProducts.length
            ? 'Selecione o produto que está sendo pesado.'
            : 'Cadastre produtos pesáveis no cardápio da empresa.';
    }
}

function setupAppTabs() {
    const tabs = document.querySelectorAll('.app-tab');
    const views = {
        print: document.getElementById('tab-print'),
        scale: document.getElementById('tab-scale'),
    };
    if (!tabs.length) return;

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.tab;
            tabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle('active', active);
                t.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            Object.entries(views).forEach(([key, el]) => {
                if (!el) return;
                const active = key === name;
                el.classList.toggle('active', active);
                if (active) el.removeAttribute('hidden');
                else el.setAttribute('hidden', '');
            });
            if (name === 'scale') {
                populateScalePrinterSelect(printerSelect?.value || '');
                loadScaleWeighingData(scaleCardCodeInput?.value || '');
                ensureScaleAutoConnect();
            }
            closeAllConfigDrawers();
        });
    });
}

function setupScaleListeners() {
    if (!window.electronAPI.onScaleWeight) return;

    window.electronAPI.onScaleWeight((reading) => applyScaleReading(reading));
    window.electronAPI.onScaleStatus((status) => applyScaleStatus(status));

    if (scaleRefreshPortsBtn) {
        scaleRefreshPortsBtn.addEventListener('click', () => loadScalePorts(scalePortSelect?.value));
    }

    if (scalePortSelect) {
        scalePortSelect.addEventListener('change', () => {
            lastScalePortPath = scalePortSelect.value || '';
        });
    }

    if (scaleConnectBtn) {
        scaleConnectBtn.addEventListener('click', async () => {
            scaleConnectBtn.disabled = true;
            scaleConnectBtn.textContent = 'Detectando...';
            showStatus('Detectando balança (baud/protocolo)...', 'info');
            const result = await window.electronAPI.scaleConnect({
                path: scalePortSelect?.value || undefined,
            });
            applyScaleStatus(result);
            if (result?.success && result.running) {
                showStatus(
                    `Balança em ${result.portPath} @ ${result.baudRate} (${result.protocol?.name || result.protocolId})`,
                    'success'
                );
            } else {
                showStatus(result?.error || result?.lastError || 'Falha ao conectar balança', 'error');
            }
        });
    }

    if (scaleStopBtn) {
        scaleStopBtn.addEventListener('click', async () => {
            const result = await window.electronAPI.scaleStop();
            applyScaleStatus(result);
            showStatus('Balança desconectada', 'info');
        });
    }

    const pushPrice = async () => {
        if (!window.electronAPI.scaleSetPrice) return;
        const price = Number(String(scalePriceInput?.value || '0').replace(',', '.'));
        const result = await window.electronAPI.scaleSetPrice(price);
        applyScaleStatus(result);
        if (result?.ack) {
            showStatus(`Preço/kg ${formatScaleMoney(result.pricePerKg)} aceito pela balança`, 'success');
        } else if (result?.appOk) {
            showStatus(
                result?.error ||
                    `Preço no app: ${formatScaleMoney(result.pricePerKg)}. Balança não aceitou (NAK) — total só no app.`,
                'error'
            );
        } else {
            showStatus(result?.error || 'Falha ao enviar preço', 'error');
        }
    };

    if (scaleSendPriceBtn) {
        scaleSendPriceBtn.addEventListener('click', pushPrice);
    }

    if (scalePriceInput) {
        scalePriceInput.addEventListener('change', pushPrice);
        scalePriceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                pushPrice();
            }
        });
    }

    if (scalePrintBtn) {
        scalePrintBtn.disabled = true;
        scalePrintBtn.addEventListener('click', async () => {
            if (!window.electronAPI.printScaleTicket) return;
            const priceFromInput = Number(String(scalePriceInput?.value || '0').replace(',', '.'));
            const pricePerKg = Number.isFinite(priceFromInput) && priceFromInput >= 0
                ? priceFromInput
                : lastScaleReading.pricePerKg;
            const kg = lastScaleReading.kg || 0;
            const total = kg * (Number.isFinite(pricePerKg) ? pricePerKg : 0);
            const printer = scalePrinterSelect?.value || '';
            scalePrintBtn.disabled = true;
            try {
                if (window.electronAPI.setScalePrinter) {
                    await window.electronAPI.setScalePrinter(printer || null);
                }
                const result = await window.electronAPI.printScaleTicket({
                    kg,
                    pricePerKg,
                    total,
                    printer: printer || null,
                    at: new Date().toISOString(),
                });
                if (result?.success) {
                    showStatus(result.message || 'Pesagem enviada para a impressora', 'success');
                } else {
                    showStatus(result?.message || 'Falha ao imprimir pesagem', 'error');
                }
            } catch (error) {
                showStatus(error?.message || 'Falha ao imprimir pesagem', 'error');
            } finally {
                updateScaleActionButtons();
            }
        });
    }

    if (scalePrinterSelect) {
        scalePrinterSelect.addEventListener('change', async () => {
            if (!window.electronAPI.setScalePrinter) return;
            const printer = scalePrinterSelect.value || null;
            await window.electronAPI.setScalePrinter(printer);
            showStatus(
                printer ? `Impressora da pesagem: ${printer}` : 'Pesagem usará a impressora padrão',
                'success'
            );
        });
    }

    if (scaleCardCodeInput) {
        syncScaleCardInputEnabled();
        scaleCardCodeInput.addEventListener('focus', () => {
            syncScaleCardInputEnabled();
            if (!scaleTabCards.length && !scaleCardsLoading) {
                loadScaleTabCards(scaleCardCodeInput.value);
            }
            const q = String(scaleCardCodeInput.value || '').trim();
            if (q) renderScaleCardResults(q, { open: true });
        });
        scaleCardCodeInput.addEventListener('input', () => {
            syncScaleCardInputEnabled();
            const typed = String(scaleCardCodeInput.value || '').trim();
            const asNumber = Number(typed);
            if (Number.isInteger(asNumber) && asNumber > 0) {
                const exact = scaleTabCards.find((c) => c.code === asNumber);
                scaleSelectedCardCode = exact ? exact.code : null;
                scaleCardCodeInput.classList.toggle('is-selected', Boolean(exact));
                scaleCardCodeInput.classList.toggle('is-active-card', Boolean(exact?.active));
                if (exact && scaleCardHint) {
                    scaleCardHint.textContent = getScaleCardSelectionHint(exact);
                }
            } else {
                scaleSelectedCardCode = null;
                scaleCardCodeInput.classList.remove('is-selected');
                scaleCardCodeInput.classList.remove('is-active-card');
                updateScaleCardActiveNotice(null);
            }
            scheduleScaleCardSearch();
            updateScaleActionButtons();
        });
        scaleCardCodeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideScaleCardResults();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (scaleActivateCardBtn && !scaleActivateCardBtn.hidden && !scaleActivateCardBtn.disabled) {
                    scaleActivateCardBtn.click();
                }
            }
        });
        scaleCardCodeInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (scaleCardActivating) return;
                if (scaleCardCombobox?.contains(document.activeElement)) return;
                hideScaleCardResults();
            }, 150);
        });
    }

    if (scaleCardRefreshBtn) {
        scaleCardRefreshBtn.addEventListener('click', () => {
            loadScaleWeighingData(scaleCardCodeInput?.value || '');
        });
    }

    if (scaleActivateCardBtn) {
        scaleActivateCardBtn.addEventListener('click', async () => {
            const code = getSelectedScaleCardCode();
            if (!code) {
                showStatus('Selecione um cartão na lista', 'error');
                return;
            }
            scaleActivateCardBtn.disabled = true;
            try {
                await activateScaleCardByCode(code);
            } finally {
                updateScaleActionButtons();
            }
        });
    }

    if (scaleProductSelect) {
        scaleProductSelect.addEventListener('change', () => {
            applySelectedWeighableProduct(scaleProductSelect.value);
            const selectedCard = getSelectedScaleCard();
            if (selectedCard && scaleCardHint) {
                scaleCardHint.textContent = getScaleCardSelectionHint(selectedCard);
            }
            updateScaleActionButtons();
        });
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

function openConfigDrawer(drawer) {
    if (!drawer) return;
    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
}

function closeConfigDrawer(drawer) {
    if (!drawer) return;
    drawer.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
}

function closeAllConfigDrawers() {
    closeConfigDrawer(printConfigDrawer);
    closeConfigDrawer(scaleConfigDrawer);
}

function setupConfigDrawers() {
    if (openPrintConfigBtn) {
        openPrintConfigBtn.addEventListener('click', async () => {
            openConfigDrawer(printConfigDrawer);
            await Promise.all([
                loadPrinterRouting().catch(() => {}),
                loadMenuCategories().catch(() => {}),
            ]);
        });
    }
    if (openScaleConfigBtn) {
        openScaleConfigBtn.addEventListener('click', async () => {
            openConfigDrawer(scaleConfigDrawer);
            await loadScalePorts(scalePortSelect?.value || lastScalePortPath).catch(() => {});
        });
    }

    document.querySelectorAll('[data-close-drawer]').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-close-drawer');
            closeConfigDrawer(document.getElementById(id));
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllConfigDrawers();
    });
}

// Setup event listeners
function setupEventListeners() {
    setupConfigDrawers();

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
        printerRouting.defaultPrinter = name;
        showStatus(name ? `Impressora principal: ${name}` : 'Usando impressora padrão do sistema', 'success');
    });
    refreshPrintersBtn.addEventListener('click', loadPrinters);
    if (testPrinterBtn) {
        testPrinterBtn.addEventListener('click', async () => {
            testPrinterBtn.disabled = true;
            try {
                const result = await window.electronAPI.testPrinter();
                showStatus(result?.message || 'Teste enviado para a impressora', result?.success ? 'success' : 'error');
                if (result?.success) showToast(result.message || 'Teste de impressora enviado', 'success');
            } catch (error) {
                showStatus(error?.message || 'Erro ao testar impressora', 'error');
            } finally {
                testPrinterBtn.disabled = false;
            }
        });
    }
    if (addPrinterRouteBtn) {
        addPrinterRouteBtn.addEventListener('click', addPrinterRoute);
    }
    if (refreshMenuCategoriesBtn) {
        refreshMenuCategoriesBtn.addEventListener('click', async () => {
            await loadMenuCategories();
            if (menuCategories.length) {
                showStatus(`${menuCategories.length} categoria(s) carregada(s)`, 'success');
            } else {
                showStatus(menuCategoriesError || 'Nenhuma categoria encontrada', 'error');
            }
        });
    }

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
        if (data.connected) {
            loadMenuCategories().catch((error) => {
                console.error('Error loading menu categories:', error);
            });
        }
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

let appToastTimer = null;

function showToast(message, type = 'success', durationMs = 4200) {
    const toast = document.getElementById('app-toast');
    if (!toast || !message) return;

    toast.hidden = false;
    toast.textContent = message;
    toast.className = `app-toast ${type} is-visible`;

    if (appToastTimer) clearTimeout(appToastTimer);
    appToastTimer = setTimeout(() => {
        toast.classList.remove('is-visible');
        setTimeout(() => {
            if (!toast.classList.contains('is-visible')) {
                toast.hidden = true;
                toast.textContent = '';
                toast.className = 'app-toast';
            }
        }, 220);
    }, durationMs);
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

function setHeaderUpdateBtn({ visible, label, phase, disabled = false }) {
    if (!headerUpdateBtn) return;
    headerUpdatePhase = phase || 'idle';
    headerUpdateBtn.classList.toggle('hidden', !visible);
    headerUpdateBtn.classList.toggle('ready-install', phase === 'ready');
    headerUpdateBtn.disabled = Boolean(disabled);
    if (label) headerUpdateBtn.textContent = label;
}

function setUpdateProgress(percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    if (updateProgressWrap) updateProgressWrap.classList.remove('hidden');
    if (updateProgressFill) updateProgressFill.style.width = `${pct}%`;
    if (updateProgressText) updateProgressText.textContent = `${pct}%`;
    if (headerUpdatePhase === 'downloading' || headerUpdatePhase === 'available') {
        setHeaderUpdateBtn({
            visible: true,
            label: `Baixando ${pct}%`,
            phase: 'downloading',
            disabled: true,
        });
    }
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
    try {
        const version = await window.electronAPI.getAppVersion();
        if (currentVersionEl) currentVersionEl.textContent = version || '—';
        await window.electronAPI.checkForUpdates();
    } catch (error) {
        console.error('Falha ao verificar atualizações:', error);
    }
}

function setupUpdateListeners() {
    if (!window.electronAPI) return;

    window.electronAPI.onUpdateAvailable((_event, data) => {
        pendingUpdateVersion = data.version || null;
        if (currentVersionEl) currentVersionEl.textContent = data.currentVersion || '—';
        if (availableVersionEl) availableVersionEl.textContent = data.version || '—';
        if (updateReleaseNotesEl) {
            const notes = data.releaseNotes ? String(data.releaseNotes).trim() : '';
            updateReleaseNotesEl.textContent = notes || 'Nova versão disponível.';
        }
        if (updateAvailableBox) updateAvailableBox.classList.remove('hidden');
        resetUpdateDownloadUi();
        setHeaderUpdateBtn({
            visible: true,
            label: pendingUpdateVersion ? `Atualizar v${pendingUpdateVersion}` : 'Atualizar',
            phase: 'available',
            disabled: false,
        });
        showStatus(`Nova versão ${pendingUpdateVersion || ''} disponível`, 'success');
    });

    window.electronAPI.onUpdateNotAvailable((_event, data) => {
        pendingUpdateVersion = null;
        if (currentVersionEl) currentVersionEl.textContent = data.currentVersion || '—';
        if (updateAvailableBox) updateAvailableBox.classList.add('hidden');
        setHeaderUpdateBtn({ visible: false, label: 'Atualizar', phase: 'idle' });
    });

    window.electronAPI.onUpdateDownloadProgress((_event, data) => {
        setUpdateProgress(Number(data.percent || 0));
    });

    window.electronAPI.onUpdateDownloaded((_event, data) => {
        setUpdateProgress(100);
        pendingUpdateVersion = data.version || pendingUpdateVersion;
        setHeaderUpdateBtn({
            visible: true,
            label: pendingUpdateVersion ? `Instalar v${pendingUpdateVersion}` : 'Instalar e reiniciar',
            phase: 'ready',
            disabled: false,
        });
        showStatus(`Versão ${pendingUpdateVersion || ''} pronta para instalar`, 'success');
    });

    window.electronAPI.onUpdateError((_event, data) => {
        resetUpdateDownloadUi();
        if (pendingUpdateVersion) {
            setHeaderUpdateBtn({
                visible: true,
                label: `Atualizar v${pendingUpdateVersion}`,
                phase: 'available',
                disabled: false,
            });
        } else {
            setHeaderUpdateBtn({ visible: false, label: 'Atualizar', phase: 'idle' });
        }
        showStatus(data.message || 'Erro na atualização', 'error');
    });

    if (headerUpdateBtn) {
        headerUpdateBtn.addEventListener('click', async () => {
            if (headerUpdatePhase === 'ready') {
                setHeaderUpdateBtn({
                    visible: true,
                    label: 'Instalando...',
                    phase: 'ready',
                    disabled: true,
                });
                await window.electronAPI.installUpdate();
                return;
            }
            if (headerUpdatePhase === 'available') {
                resetUpdateDownloadUi();
                setHeaderUpdateBtn({
                    visible: true,
                    label: 'Baixando 0%',
                    phase: 'downloading',
                    disabled: true,
                });
                await window.electronAPI.downloadUpdate();
            }
        });
    }
}
