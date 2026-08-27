'use strict';

const AUTO_PRINT_FILTER_KEYS = ['table', 'pickup', 'delivery', 'marketplace'];

const DEFAULT_AUTO_PRINT_FILTERS = {
  table: true,
  pickup: true,
  delivery: true,
  marketplace: true,
};

const KNOWN_MARKETPLACES = new Set([
  'pedeai',
  'ifood',
  'rappi',
  '99food',
  'ubereats',
  'uber_eats',
  'keeta',
  'aiqfome',
  'anotaai',
  'anota_ai',
  'deliverymuch',
  'glovo',
  'menudino',
  'olaclick',
  'whatsapp',
]);

const INTERNAL_PLATFORMS = new Set([
  '',
  'linkeats',
  'internal',
  'app',
  'web',
  'pos',
  'balcao',
  'balcão',
  'totem',
  'pdv',
]);

function normalizePlatformKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function resolveOrderPlatform(order) {
  const candidates = [
    order?.platform,
    order?.source,
    order?.channel,
    order?.marketplace,
    order?.origin,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePlatformKey(candidate);
    if (normalized) return normalized;
  }

  const observation = String(order?.observation || '');
  if (/pedido pede\.ai/i.test(observation) || /pede\.ai/i.test(observation)) {
    return 'pedeai';
  }

  return '';
}

function isMarketplacePlatform(platform) {
  const normalized = normalizePlatformKey(platform);
  if (!normalized || INTERNAL_PLATFORMS.has(normalized)) return false;
  if (KNOWN_MARKETPLACES.has(normalized)) return true;
  return normalized.length > 0;
}

function normalizeAutoPrintFilters(raw = {}) {
  const normalized = { ...DEFAULT_AUTO_PRINT_FILTERS };
  AUTO_PRINT_FILTER_KEYS.forEach((key) => {
    if (raw[key] != null) normalized[key] = Boolean(raw[key]);
  });
  return normalized;
}

function classifyOrderAutoPrintCategories(order = {}) {
  const categories = new Set();

  if (order?.kind === 'tab_print') {
    categories.add('table');
    return Array.from(categories);
  }

  const platform = resolveOrderPlatform(order);
  if (isMarketplacePlatform(platform)) {
    categories.add('marketplace');
  }

  const orderType = String(order?.order_type || '').toLowerCase();

  if (
    orderType === 'table' ||
    order?.table_name ||
    order?.waiter_name ||
    order?.print_location_type === 'card' ||
    order?.tab_card_label
  ) {
    categories.add('table');
  }

  if (orderType === 'pickup') {
    categories.add('pickup');
  }

  if (orderType === 'delivery' || order?.delivery_address || order?.address_street) {
    categories.add('delivery');
  }

  return Array.from(categories);
}

function shouldAutoPrintOrder(order, filters = DEFAULT_AUTO_PRINT_FILTERS) {
  const normalized = normalizeAutoPrintFilters(filters);
  const enabledKeys = AUTO_PRINT_FILTER_KEYS.filter((key) => normalized[key]);
  if (!enabledKeys.length) return false;

  const categories = classifyOrderAutoPrintCategories(order);
  if (!categories.length) {
    return enabledKeys.length === AUTO_PRINT_FILTER_KEYS.length;
  }

  return categories.some((category) => normalized[category]);
}

function getAutoPrintFilterLabels() {
  return {
    table: 'Mesas e comandas',
    pickup: 'Retirada',
    delivery: 'Delivery',
    marketplace: 'Marketplaces (Pede.ai, iFood, etc.)',
  };
}

module.exports = {
  AUTO_PRINT_FILTER_KEYS,
  DEFAULT_AUTO_PRINT_FILTERS,
  KNOWN_MARKETPLACES,
  normalizeAutoPrintFilters,
  classifyOrderAutoPrintCategories,
  shouldAutoPrintOrder,
  resolveOrderPlatform,
  isMarketplacePlatform,
  getAutoPrintFilterLabels,
};
