'use strict';

const crypto = require('crypto');

function createRouteId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getItemCategoryId(item) {
  return (
    item?.category_id ||
    item?.product?.category_id ||
    item?.product?.category?.id ||
    item?.Product?.category_id ||
    null
  );
}

function normalizeRoute(route = {}) {
  const categoryIds = Array.isArray(route.categoryIds)
    ? route.categoryIds.map((id) => String(id)).filter(Boolean)
    : [];
  return {
    id: route.id ? String(route.id) : createRouteId(),
    printer: route.printer ? String(route.printer) : '',
    categoryIds,
  };
}

function normalizePrinterRouting(raw = {}) {
  const routes = Array.isArray(raw.routes) ? raw.routes.map(normalizeRoute) : [];
  return {
    defaultPrinter: raw.defaultPrinter ? String(raw.defaultPrinter) : null,
    routes: routes.filter((route) => route.printer || route.categoryIds.length > 0),
  };
}

function hasActiveRouting(routing) {
  const normalized = normalizePrinterRouting(routing);
  return normalized.routes.some((route) => route.printer && route.categoryIds.length > 0);
}

function buildCategoryToPrinterMap(routing) {
  const map = new Map();
  for (const route of normalizePrinterRouting(routing).routes) {
    if (!route.printer) continue;
    for (const categoryId of route.categoryIds) {
      if (!map.has(categoryId)) map.set(categoryId, route.printer);
    }
  }
  return map;
}

function buildCategoryNamesById(routing) {
  const names = new Map();
  for (const route of normalizePrinterRouting(routing).routes) {
    for (const categoryId of route.categoryIds) {
      if (!names.has(categoryId) && route.categoryNames?.[categoryId]) {
        names.set(categoryId, route.categoryNames[categoryId]);
      }
    }
  }
  return names;
}

function resolvePrinterForItem(item, categoryMap, defaultPrinter) {
  const categoryId = getItemCategoryId(item);
  if (categoryId && categoryMap.has(String(categoryId))) {
    return categoryMap.get(String(categoryId));
  }
  return defaultPrinter || null;
}

function summarizeRouteLabel(items, categoryMap, categoryNames = new Map()) {
  const names = new Set();
  for (const item of items || []) {
    const categoryId = getItemCategoryId(item);
    if (!categoryId) continue;
    const mappedPrinter = categoryMap.get(String(categoryId));
    if (!mappedPrinter) continue;
    names.add(categoryNames.get(String(categoryId)) || item?.category_name || `Categoria ${categoryId.slice(0, 6)}`);
  }
  if (!names.size) return 'Via parcial';
  return `Destino: ${Array.from(names).join(', ')}`;
}

function groupItemsByPrinter(items, routing) {
  const normalized = normalizePrinterRouting(routing);
  const categoryMap = buildCategoryToPrinterMap(normalized);
  const defaultPrinter = normalized.defaultPrinter || null;
  const groups = new Map();

  for (const item of items || []) {
    const printer = resolvePrinterForItem(item, categoryMap, defaultPrinter);
    const key = printer || '__default__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return { groups, categoryMap, defaultPrinter };
}

function splitOrderPrintJobs(order, routing) {
  const normalized = normalizePrinterRouting(routing);
  if (!hasActiveRouting(normalized)) {
    return [{
      printer: normalized.defaultPrinter || null,
      partial: false,
      includePayment: true,
      includeClient: true,
      routeLabel: '',
      order,
    }];
  }

  const { groups, categoryMap, defaultPrinter } = groupItemsByPrinter(order?.items || [], normalized);
  const categoryNames = buildCategoryNamesById(normalized);
  const entries = Array.from(groups.entries()).filter(([, items]) => items.length > 0);
  if (!entries.length) {
    return [{
      printer: defaultPrinter || null,
      partial: false,
      includePayment: true,
      includeClient: true,
      routeLabel: '',
      order,
    }];
  }

  const multipleJobs = entries.length > 1;
  return entries.map(([printerKey, items]) => {
    const printer = printerKey === '__default__' ? defaultPrinter : printerKey;
    const isDefaultGroup = printerKey === '__default__';
    const includePayment = !multipleJobs || isDefaultGroup;
    const includeClient = !multipleJobs || isDefaultGroup;
    return {
      printer: printer || null,
      partial: multipleJobs,
      includePayment,
      includeClient,
      routeLabel: multipleJobs && !isDefaultGroup ? summarizeRouteLabel(items, categoryMap, categoryNames) : '',
      order: { ...order, items },
    };
  });
}

function splitTabPrintJobs(tabData, routing) {
  const normalized = normalizePrinterRouting(routing);
  if (!hasActiveRouting(normalized)) {
    return [{
      printer: normalized.defaultPrinter || null,
      partial: false,
      includePayment: true,
      routeLabel: '',
      tabData,
    }];
  }

  const allItems = (tabData?.orders || []).flatMap((order) => order?.items || []);
  const { groups, categoryMap, defaultPrinter } = groupItemsByPrinter(allItems, normalized);
  const categoryNames = buildCategoryNamesById(normalized);
  const entries = Array.from(groups.entries()).filter(([, items]) => items.length > 0);
  if (!entries.length) {
    return [{
      printer: defaultPrinter || null,
      partial: false,
      includePayment: true,
      routeLabel: '',
      tabData,
    }];
  }

  const multipleJobs = entries.length > 1;
  return entries.map(([printerKey, groupedItems]) => {
    const printer = printerKey === '__default__' ? defaultPrinter : printerKey;
    const isDefaultGroup = printerKey === '__default__';
    const includePayment = !multipleJobs || isDefaultGroup;
    const targetPrinter = printer || null;
    const itemFilter = (item) => {
      const resolved = resolvePrinterForItem(item, categoryMap, defaultPrinter);
      if (isDefaultGroup) {
        const categoryId = getItemCategoryId(item);
        if (categoryId && categoryMap.has(String(categoryId))) return false;
        return resolved === targetPrinter || resolved == null;
      }
      return resolved === targetPrinter;
    };
    return {
      printer: targetPrinter,
      partial: multipleJobs,
      includePayment,
      routeLabel: multipleJobs && !isDefaultGroup ? summarizeRouteLabel(groupedItems, categoryMap, categoryNames) : '',
      tabData,
      itemFilter,
    };
  });
}

module.exports = {
  createRouteId,
  normalizePrinterRouting,
  hasActiveRouting,
  splitOrderPrintJobs,
  splitTabPrintJobs,
  getItemCategoryId,
  resolvePrinterForItem,
  buildCategoryToPrinterMap,
};
