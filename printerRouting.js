'use strict';

const crypto = require('crypto');
const { normalizeFontScale, DEFAULT_FONT_SCALE } = require('./printFormat');

function createRouteId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePaperWidth(value) {
  return value === '80mm' ? '80mm' : '58mm';
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

function normalizeRoute(route = {}, defaults = {}) {
  const categoryIds = Array.isArray(route.categoryIds)
    ? route.categoryIds.map((id) => String(id)).filter(Boolean)
    : [];
  const categoryNames =
    route.categoryNames && typeof route.categoryNames === 'object' ? route.categoryNames : undefined;
  const defaultFont = defaults.fontScale != null ? defaults.fontScale : DEFAULT_FONT_SCALE;
  const defaultPaper = defaults.paperWidth || '58mm';
  return {
    id: route.id ? String(route.id) : createRouteId(),
    printer: route.printer ? String(route.printer) : '',
    categoryIds,
    fontScale: normalizeFontScale(
      route.fontScale != null ? route.fontScale : route.font_scale != null ? route.font_scale : defaultFont
    ),
    paperWidth: normalizePaperWidth(
      route.paperWidth != null ? route.paperWidth : route.paper_width != null ? route.paper_width : defaultPaper
    ),
    autoPrint: route.autoPrint === true || route.auto_print === true,
    alsoPrintOnMain: route.alsoPrintOnMain === true || route.printOnMain === true || route.print_on_main === true,
    ...(categoryNames ? { categoryNames } : {}),
  };
}

function normalizePrinterRouting(raw = {}, defaults = {}) {
  const routes = Array.isArray(raw.routes)
    ? raw.routes.map((route) => normalizeRoute(route, defaults))
    : [];
  return {
    defaultPrinter: raw.defaultPrinter ? String(raw.defaultPrinter) : null,
    routes,
  };
}

function resolvePrintOptionsForPrinter(printerName, routing, defaults = {}) {
  const normalized = normalizePrinterRouting(routing, defaults);
  const fallback = {
    fontScale: normalizeFontScale(defaults.fontScale ?? DEFAULT_FONT_SCALE),
    paperWidth: normalizePaperWidth(defaults.paperWidth),
  };
  if (!printerName || printerName === normalized.defaultPrinter) {
    return fallback;
  }
  const route = normalized.routes.find(
    (item) => item.printer === printerName && item.categoryIds.length > 0
  );
  if (!route) {
    const draft = normalized.routes.find((item) => item.printer === printerName);
    if (!draft) return fallback;
    return {
      fontScale: normalizeFontScale(draft.fontScale),
      paperWidth: normalizePaperWidth(draft.paperWidth),
    };
  }
  return {
    fontScale: normalizeFontScale(route.fontScale),
    paperWidth: normalizePaperWidth(route.paperWidth),
  };
}

function hasActiveRouting(routing) {
  const normalized = normalizePrinterRouting(routing);
  return normalized.routes.some((route) => route.printer && route.categoryIds.length > 0);
}

function buildCategoryRouteMap(routing) {
  const map = new Map();
  for (const route of normalizePrinterRouting(routing).routes) {
    if (!route.printer || !route.categoryIds.length) continue;
    for (const categoryId of route.categoryIds) {
      if (!map.has(categoryId)) map.set(categoryId, route);
    }
  }
  return map;
}

function buildCategoryToPrinterMap(routing) {
  const map = new Map();
  for (const [categoryId, route] of buildCategoryRouteMap(routing).entries()) {
    map.set(categoryId, route.printer);
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

function resolveRouteForItem(item, categoryRouteMap) {
  const categoryId = getItemCategoryId(item);
  if (!categoryId) return null;
  return categoryRouteMap.get(String(categoryId)) || null;
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

function pushUniqueItem(list, item, seen) {
  const key = item?.id || `${item?.product_id || ''}|${item?.name || ''}|${list.length}`;
  if (seen.has(key)) return;
  seen.set(key, true);
  list.push(item);
}

function groupItemsByPrinter(items, routing) {
  const normalized = normalizePrinterRouting(routing);
  const categoryRouteMap = buildCategoryRouteMap(normalized);
  const categoryMap = buildCategoryToPrinterMap(normalized);
  const defaultPrinter = normalized.defaultPrinter || null;
  const groups = new Map();
  const seenByGroup = new Map();

  const ensureGroup = (key) => {
    if (!groups.has(key)) {
      groups.set(key, []);
      seenByGroup.set(key, new Map());
    }
    return groups.get(key);
  };

  for (const item of items || []) {
    const route = resolveRouteForItem(item, categoryRouteMap);
    if (route?.printer) {
      const auxKey = route.printer;
      pushUniqueItem(ensureGroup(auxKey), item, seenByGroup.get(auxKey));
      if (route.alsoPrintOnMain) {
        pushUniqueItem(ensureGroup('__default__'), item, seenByGroup.get('__default__'));
      }
      continue;
    }
    pushUniqueItem(ensureGroup('__default__'), item, seenByGroup.get('__default__'));
  }

  return { groups, categoryMap, categoryRouteMap, defaultPrinter };
}

function attachJobPrintOptions(job, routing, defaults) {
  return {
    ...job,
    ...resolvePrintOptionsForPrinter(job.printer, routing, defaults),
  };
}

function findRouteByPrinter(routing, printerName) {
  if (!printerName) return null;
  return normalizePrinterRouting(routing).routes.find(
    (route) => route.printer === printerName && route.categoryIds.length > 0
  ) || null;
}

function isMainPrinterJob(job, routing) {
  const normalized = normalizePrinterRouting(routing);
  if (job?.isDefault) return true;
  if (!job?.printer) return true;
  return job.printer === normalized.defaultPrinter;
}

function filterJobsForAutoPrint(jobs, routing, mainAutoPrintEnabled) {
  const normalized = normalizePrinterRouting(routing);
  return (jobs || []).filter((job) => {
    if (!job?.order?.items?.length && !job?.tabData && !job?.itemFilter) {
      // Keep tab jobs; for orders require items
    }
    if (job?.order && Array.isArray(job.order.items) && job.order.items.length === 0) {
      return false;
    }
    if (isMainPrinterJob(job, normalized)) {
      return Boolean(mainAutoPrintEnabled);
    }
    const route = findRouteByPrinter(normalized, job.printer);
    return Boolean(route?.autoPrint);
  });
}

function splitOrderPrintJobs(order, routing, defaults = {}) {
  const normalized = normalizePrinterRouting(routing, defaults);
  if (!hasActiveRouting(normalized)) {
    return [attachJobPrintOptions({
      printer: normalized.defaultPrinter || null,
      isDefault: true,
      partial: false,
      includePayment: true,
      includeClient: true,
      routeLabel: '',
      order,
    }, normalized, defaults)];
  }

  const { groups, categoryMap, defaultPrinter } = groupItemsByPrinter(order?.items || [], normalized);
  const categoryNames = buildCategoryNamesById(normalized);
  const entries = Array.from(groups.entries()).filter(([, items]) => items.length > 0);
  if (!entries.length) {
    return [attachJobPrintOptions({
      printer: defaultPrinter || null,
      isDefault: true,
      partial: false,
      includePayment: true,
      includeClient: true,
      routeLabel: '',
      order,
    }, normalized, defaults)];
  }

  const multipleJobs = entries.length > 1;
  return entries.map(([printerKey, items]) => {
    const isDefaultGroup = printerKey === '__default__';
    const printer = isDefaultGroup ? defaultPrinter : printerKey;
    const includePayment = !multipleJobs || isDefaultGroup;
    const includeClient = !multipleJobs || isDefaultGroup;
    return attachJobPrintOptions({
      printer: printer || null,
      isDefault: isDefaultGroup,
      partial: multipleJobs,
      includePayment,
      includeClient,
      routeLabel: multipleJobs && !isDefaultGroup ? summarizeRouteLabel(items, categoryMap, categoryNames) : '',
      order: { ...order, items },
    }, normalized, defaults);
  });
}

function splitTabPrintJobs(tabData, routing, defaults = {}) {
  const normalized = normalizePrinterRouting(routing, defaults);
  if (!hasActiveRouting(normalized)) {
    return [attachJobPrintOptions({
      printer: normalized.defaultPrinter || null,
      isDefault: true,
      partial: false,
      includePayment: true,
      routeLabel: '',
      tabData,
    }, normalized, defaults)];
  }

  const weighableItems = Array.isArray(tabData?.weighable_items) ? tabData.weighable_items : [];
  const allItems = [
    ...weighableItems,
    ...(tabData?.orders || []).flatMap((order) => order?.items || []),
  ];
  const { groups, categoryMap, categoryRouteMap, defaultPrinter } = groupItemsByPrinter(allItems, normalized);
  const categoryNames = buildCategoryNamesById(normalized);
  const entries = Array.from(groups.entries()).filter(([, items]) => items.length > 0);
  if (!entries.length) {
    return [attachJobPrintOptions({
      printer: defaultPrinter || null,
      isDefault: true,
      partial: false,
      includePayment: true,
      routeLabel: '',
      tabData,
    }, normalized, defaults)];
  }

  const multipleJobs = entries.length > 1;
  return entries.map(([printerKey, groupedItems]) => {
    const isDefaultGroup = printerKey === '__default__';
    const printer = isDefaultGroup ? defaultPrinter : printerKey;
    const includePayment = !multipleJobs || isDefaultGroup;
    const targetPrinter = printer || null;
    const itemFilter = (item) => {
      const route = resolveRouteForItem(item, categoryRouteMap);
      if (isDefaultGroup) {
        if (!route) return true;
        return Boolean(route.alsoPrintOnMain);
      }
      return route?.printer === targetPrinter;
    };
    return attachJobPrintOptions({
      printer: targetPrinter,
      isDefault: isDefaultGroup,
      partial: multipleJobs,
      includePayment,
      routeLabel: multipleJobs && !isDefaultGroup ? summarizeRouteLabel(groupedItems, categoryMap, categoryNames) : '',
      tabData,
      itemFilter,
    }, normalized, defaults);
  });
}

module.exports = {
  createRouteId,
  normalizePrinterRouting,
  normalizeRoute,
  normalizePaperWidth,
  hasActiveRouting,
  splitOrderPrintJobs,
  splitTabPrintJobs,
  filterJobsForAutoPrint,
  isMainPrinterJob,
  getItemCategoryId,
  resolvePrinterForItem,
  resolvePrintOptionsForPrinter,
  buildCategoryToPrinterMap,
  buildCategoryRouteMap,
};
