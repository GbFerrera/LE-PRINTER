'use strict';

const PAPER_WIDTHS = {
  '58mm': 32,
  '80mm': 48,
};

function getReceiptWidth(paperWidth) {
  return PAPER_WIDTHS[paperWidth === '80mm' ? '80mm' : '58mm'];
}

// 6–8 usam pipeline especial no printer.py (fatias GDI menores + render 1x).
const ALLOWED_FONT_SCALES = [1, 2, 3, 4, 5, 6, 7, 8];
const DEFAULT_FONT_SCALE = 4;

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

function snapFontScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SCALE;
  let best = ALLOWED_FONT_SCALES[0];
  let bestDist = Math.abs(parsed - best);
  for (const scale of ALLOWED_FONT_SCALES) {
    const dist = Math.abs(parsed - scale);
    if (dist < bestDist) {
      best = scale;
      bestDist = dist;
    }
  }
  return best;
}

function normalizeFontScale(value) {
  const legacyMap = {
    compact: 3,
    normal: 4,
    medium: 5,
    medium_large: 7,
    large: 8,
  };
  if (typeof value === 'string' && legacyMap[value]) return legacyMap[value];
  return snapFontScale(value);
}

function getFontScaleLabel(scale) {
  const normalized = normalizeFontScale(scale);
  return FONT_SCALE_LABELS[normalized] || FONT_SCALE_LABELS[DEFAULT_FONT_SCALE];
}

function formatMoneyBR(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'R$ 0,00';
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

function formatSection(title, receiptWidth = 32) {
  // Laterais curtas (máx. 3): preencher a largura inteira com '=' faz "ITENS DO PEDIDO" quebrar em 2 linhas na imagem.
  const label = String(title || '').trim().toUpperCase();
  const maxSide = 3;
  const room = Math.max(0, receiptWidth - label.length - 2);
  const side = Math.max(1, Math.min(maxSide, Math.floor(room / 2)));
  return `${'='.repeat(side)} ${label} ${'='.repeat(side)}`;
}

function formatDateTimeBR(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '-';
  const date = d.toLocaleDateString('pt-BR');
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

function padLine(left, right, width = 32) {
  const l = String(left || '');
  const r = String(right || '');
  const gap = width - l.length - r.length;
  if (gap >= 1) return l + ' '.repeat(gap) + r;
  return `${l}\n${r}`;
}

function wrapText(text, width = 32) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const words = raw.split(' ');
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      return;
    }
    if (current) lines.push(current);
    if (word.length <= width) {
      current = word;
    } else {
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      current = '';
    }
  });
  if (current) lines.push(current);
  return lines;
}

function formatDisplayNumber(id, number) {
  if (number != null && number !== '') return `#${number}`;
  if (!id) return '#0000';
  const base = String(id).replace(/-/g, '').slice(0, 8);
  const numericHash = parseInt(base, 16);
  if (Number.isNaN(numericHash)) {
    return `#${base.slice(-4).padStart(4, '0')}`;
  }
  return `#${String(numericHash).slice(0, 4).padStart(4, '0')}`;
}

function getPaymentMethodText(method) {
  const key = String(method || '').trim().toLowerCase();
  const methods = {
    money: 'Dinheiro',
    cash: 'Dinheiro',
    pix: 'PIX',
    card: 'Cartão',
    credit_card: 'Cartão de Crédito',
    debit_card: 'Cartão de Débito',
    online: 'Pagamento online',
  };
  return methods[key] || (method ? String(method) : 'Não informado');
}

function getPlatformLabel(platform) {
  const key = String(platform || '').trim().toLowerCase();
  if (key === 'pedeai') return 'Pede.ai';
  if (key === 'ifood') return 'iFood';
  return null;
}

function getComplementName(complement) {
  return (
    complement?.complement?.name ||
    complement?.Complement?.name ||
    complement?.name ||
    ''
  );
}

function getComplementPrice(complement) {
  const raw = complement?.price;
  const parsed = raw == null ? 0 : parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getComplementQuantity(complement) {
  const candidates = [
    complement?.quantity,
    complement?.qtd,
    complement?.amount,
    complement?.default_qtd,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 1;
}

function getComplementGroupIsNegative(complement) {
  const raw =
    complement?.complement?.group_is_negative ??
    complement?.group_is_negative ??
    complement?.Complement?.ComplementGroup?.is_negative;
  return Boolean(raw);
}

function aggregateComplements(complements) {
  const grouped = new Map();

  (complements || []).forEach((complement) => {
    const name = getComplementName(complement);
    if (!name) return;

    const groupName = complement?.complement?.group_name || complement?.group_name || '';
    const isNegative = getComplementGroupIsNegative(complement);
    const unitPrice = getComplementPrice(complement);
    const qty = getComplementQuantity(complement);
    const key = `${isNegative ? 'neg' : 'pos'}::${groupName}::${name}::${unitPrice.toFixed(2)}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.quantity += qty;
    } else {
      grouped.set(key, { name, groupName, unitPrice, quantity: qty, isNegative });
    }
  });

  return Array.from(grouped.values());
}

function calculateItemUnitTotal(item) {
  const base = Number(item?.price) || 0;
  let complementTotal = 0;
  aggregateComplements(item?.complements).forEach((c) => {
    complementTotal += c.unitPrice * c.quantity;
  });
  return base + complementTotal;
}

function calculateProductsSubtotal(order) {
  if (order?.products_subtotal != null && Number.isFinite(Number(order.products_subtotal))) {
    return Number(order.products_subtotal);
  }

  return (order?.items || []).reduce((sum, item) => {
    const qty = Math.max(1, Number(item?.quantity) || 1);
    return sum + calculateItemUnitTotal(item) * qty;
  }, 0);
}

function resolvePaymentSummary(order) {
  if (Array.isArray(order?.payments) && order.payments.length > 0) {
    return order.payments
      .map((payment) => {
        const method = getPaymentMethodText(payment?.method);
        const amount = formatMoneyBR(payment?.amount);
        let line = `${method} (${amount})`;
        if (payment?.change_for) {
          const change = Number(payment.change_for) - Number(payment.amount || 0);
          line += ` | Troco p/ ${formatMoneyBR(payment.change_for)} (${formatMoneyBR(change)})`;
        }
        return line;
      })
      .join('\n');
  }

  if (order?.payment_method) {
    return getPaymentMethodText(order.payment_method);
  }

  const observation = String(order?.observation || '');
  const pedeAiPayment = observation
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^pedido pede\.ai$/i.test(line));
  if (pedeAiPayment) return pedeAiPayment;

  return 'Não informado';
}

function formatItemBlock(item, index, receiptWidth = 32) {
  const lines = [];
  const qty = Math.max(1, Number(item?.quantity) || 1);
  const itemName = (item?.product?.name || item?.name || 'Item').toUpperCase();
  const unitTotal = calculateItemUnitTotal(item);
  const lineTotal = unitTotal * qty;
  const unitLabel = qty === 1 ? '1 un' : `${qty} un`;

  lines.push({
    text: `${unitLabel} ${itemName} (${formatMoneyBR(unitTotal)} - ${formatMoneyBR(lineTotal)})`,
    style: 'bold',
  });

  aggregateComplements(item?.complements).forEach((c) => {
    const linePrice = c.unitPrice * c.quantity;
    const qtyPrefix = c.quantity > 1 ? `${c.quantity}x ` : '';
    if (String(c.name).includes('\n')) {
      String(c.name).split('\n').forEach((part, partIndex) => {
        const trimmed = part.trim();
        if (!trimmed) return;
        const priceSuffix = partIndex === 0 && linePrice !== 0 ? ` (${formatMoneyBR(linePrice)})` : '';
        lines.push(`> ${trimmed}${priceSuffix}`);
      });
      return;
    }
    let label;
    if (c.isNegative) {
      label = c.groupName ? `Sem ${c.groupName.toLowerCase()}: ${c.name}` : `Sem: ${c.name}`;
    } else if (c.groupName) {
      label = `${c.groupName.toLowerCase()}: ${qtyPrefix}${c.name}`;
    } else {
      label = `${qtyPrefix}${c.name}`;
    }
    const priceSuffix = linePrice !== 0 ? ` (${formatMoneyBR(linePrice)})` : '';
    lines.push(`> ${label}${priceSuffix}`);
  });

  const itemObsRaw = item?.observations ?? item?.observation ?? item?.observacao ?? item?.notes ?? item?.obs ?? '';
  const itemObs = typeof itemObsRaw === 'string' ? itemObsRaw.trim() : String(itemObsRaw || '').trim();
  if (itemObs) {
    wrapText(`Obs: ${itemObs}`, receiptWidth).forEach((line) => lines.push(`> ${line}`));
  }

  if (index >= 0) lines.push('');
  return lines;
}

function formatClientSection(order, receiptWidth = 32) {
  const lines = [];
  const bold = (text) => ({ text, style: 'bold' });
  const orderType = String(order?.order_type || '').toLowerCase();
  const platform = getPlatformLabel(order?.platform);
  const customerName = order?.customer_name || order?.tab_customer_name;
  const customerPhone = order?.customer_phone;

  if (orderType === 'table') {
    lines.push(bold(formatSection('Mesa', receiptWidth)));
    if (order?.table_name) lines.push(bold(`Mesa: ${order.table_name}`));
    if (order?.waiter_name) lines.push(bold(`Garçom: ${order.waiter_name}`));
    if (customerName) lines.push(bold(`Cliente: ${customerName}`));
    if (order?.people_count) lines.push(bold(`Pessoas: ${order.people_count}`));
    return lines;
  }

  if (orderType === 'pickup') {
    lines.push(bold(formatSection('Retirada / Cliente', receiptWidth)));
  } else {
    lines.push(bold(formatSection('Entrega / Cliente', receiptWidth)));
  }

  if (platform) lines.push(bold(`Origem: ${platform}`));
  if (customerName) lines.push(bold(`Nome: ${customerName}`));
  if (customerPhone) lines.push(bold(`Telefone: ${customerPhone}`));
  if (order?.customer_orders_count != null) {
    lines.push(bold(`Numero de pedidos: ${order.customer_orders_count}`));
  }

  if (orderType === 'delivery') {
    if (order?.address_street) {
      const number = order?.address_number || 'S/N';
      lines.push(bold(`Endereco: ${order.address_street}, ${number}`));
    }
    if (order?.address_neighborhood) lines.push(bold(`Bairro: ${order.address_neighborhood}`));
    if (order?.address_complement) lines.push(bold(`Complemento: ${order.address_complement}`));
    if (order?.address_city) lines.push(bold(`Cidade: ${order.address_city}`));
    if (order?.address_zip) lines.push(bold(`CEP: ${order.address_zip}`));
    if (order?.address_reference) {
      wrapText(`Referencia: ${order.address_reference}`, receiptWidth).forEach((line) => {
        lines.push(bold(line));
      });
    }
  }

  if (order?.driver?.name) lines.push(bold(`Entregador: ${order.driver.name}`));

  return lines;
}

function documentToPlainText(doc) {
  return (doc?.lines || []).map((line) => line.text).join('\n');
}

function createStyledReceipt(options = {}) {
  const styledLines = [];

  return {
    push(text, style = 'normal') {
      if (text == null) return;
      if (text === '') {
        styledLines.push({ text: '', style: 'blank' });
        return;
      }
      styledLines.push({ text: String(text), style });
    },
    pushAll(strings, style = 'normal') {
      (strings || []).forEach((entry) => {
        if (entry && typeof entry === 'object' && entry.text != null) {
          this.push(entry.text, entry.style || style);
          return;
        }
        if (entry === '') this.push('');
        else this.push(entry, style);
      });
    },
    pushWrapped(text, style = 'normal', receiptWidth = 32) {
      wrapText(text, receiptWidth).forEach((line) => this.push(line, style));
    },
    toDocument(extra = {}) {
      return {
        paper_width: options.paperWidth === '80mm' ? '80mm' : '58mm',
        font_scale: normalizeFontScale(options.fontScale ?? 5),
        render_mode: 'image',
        lines: styledLines,
        ...extra,
      };
    },
  };
}

function buildOrderReceipt(order, companyName, options = {}) {
  const receiptWidth = getReceiptWidth(options.paperWidth);
  const doc = createStyledReceipt(options);
  const empresa = companyName || order?.company_name || 'LINK EATS';
  const orderNumber = formatDisplayNumber(order?.id, order?.order_number);
  const createdAt = formatDateTimeBR(order?.created_at);
  const platform = getPlatformLabel(order?.platform);
  const productsSubtotal = calculateProductsSubtotal(order);
  const deliveryFee = order?.order_type === 'delivery' ? Number(order?.delivery_fee || 0) : 0;
  const discount = Number(order?.discount || 0);
  const total = Number(order?.total || 0) || Math.max(0, productsSubtotal + deliveryFee - discount);
  const paymentSummary = resolvePaymentSummary(order);

  doc.push(`ESTABELECIMENTO: ${empresa}`, 'title');
  doc.push(padLine(`Pedido: ${orderNumber}`, `Data: ${createdAt}`, receiptWidth));

  if (platform) doc.push(`Origem: ${platform}`);
  if (order?.order_type === 'table' && order?.table_name) doc.push(`Mesa: ${order.table_name}`);
  if (order?.waiter_name) doc.push(`Garçom: ${order.waiter_name}`);
  if (order?.is_scheduled && order?.scheduled_for) {
    doc.push(`Agendado: ${formatDateTimeBR(order.scheduled_for)}`);
  }
  doc.push('');

  doc.push(formatSection('Itens do Pedido', receiptWidth), 'bold');
  if (order?.items?.length) {
    order.items.forEach((item, index) => {
      doc.pushAll(formatItemBlock(item, index, receiptWidth));
    });
  } else {
    doc.push('Nenhum item');
    doc.push('');
  }

  doc.push(formatSection('Pagamento', receiptWidth), 'bold');
  doc.push(`Total de produtos: ${formatMoneyBR(productsSubtotal)}`);
  if (deliveryFee > 0) doc.push(`Taxa de entrega: ${formatMoneyBR(deliveryFee)}`);
  if (discount > 0) doc.push(`Desconto: -${formatMoneyBR(discount)}`);
  doc.push(`TOTAL: ${formatMoneyBR(total)}`, 'total');
  doc.push(`Forma de pagamento: ${paymentSummary}`);
  doc.push('');

  const generalObs = String(order?.observation || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^pedido pede\.ai$/i.test(line)) return false;
      if (paymentSummary && line.toLowerCase() === paymentSummary.toLowerCase()) return false;
      return true;
    })
    .join('\n')
    .trim();

  const clientLines = formatClientSection(order, receiptWidth);
  doc.pushAll(clientLines);
  if (clientLines.length > 0) doc.push('');

  if (generalObs && !paymentSummary.includes(generalObs)) {
    doc.push(formatSection('Observacoes', receiptWidth), 'bold');
    doc.pushWrapped(generalObs, 'normal', receiptWidth);
    doc.push('');
  }

  doc.push('Nao e valido como documento fiscal.');
  doc.push('Solicite o documento fiscal ao estabelecimento.');
  doc.push('');
  doc.push('Link Eats', 'bold');
  doc.push('www.linkeats.com.br');
  doc.push('');
  doc.push('');
  doc.push('');

  return doc.toDocument({ kind: 'order', header_title: 'NOVO PEDIDO' });
}

function buildTabReceipt(tabData, companyName, options = {}) {
  const receiptWidth = getReceiptWidth(options.paperWidth);
  const doc = createStyledReceipt(options);
  const empresa = companyName || tabData?.company_name || 'LINK EATS';
  const tableName = tabData?.table_name || tabData?.tab_id || '-';
  const orders = Array.isArray(tabData?.orders) ? tabData.orders : [];

  doc.push(`ESTABELECIMENTO: ${empresa}`, 'title');
  doc.push(formatSection('Comanda', receiptWidth), 'bold');
  doc.push(`Comanda: ${formatDisplayNumber(tabData?.tab_id)}`);
  doc.push(`Mesa: ${tableName}`);
  if (tabData?.customer_name) doc.push(`Responsavel: ${tabData.customer_name}`);
  if (tabData?.people_count) doc.push(`Pessoas: ${tabData.people_count}`);
  doc.push(`Pedidos: ${orders.length}`);
  if (tabData?.opened_at) doc.push(`Aberta em: ${formatDateTimeBR(tabData.opened_at)}`);
  doc.push('');

  orders.forEach((order, orderIdx) => {
    doc.push(formatSection(`Pedido ${orderIdx + 1}`, receiptWidth), 'bold');
    doc.push(`Pedido: ${formatDisplayNumber(order?.id, order?.order_number)}`);
    doc.push(`Hora: ${formatDateTimeBR(order?.created_at)}`);
    if (order?.customer_name) doc.push(`Cliente: ${order.customer_name}`);
    if (order?.waiter_name) doc.push(`Garçom: ${order.waiter_name}`);
    doc.push('');

    (order?.items || []).forEach((item, idx) => {
      doc.pushAll(formatItemBlock(item, idx, receiptWidth));
    });

    if (order?.observation) {
      doc.pushWrapped(`Obs: ${order.observation}`, 'normal', receiptWidth);
      doc.push('');
    }

    doc.push(`Total pedido: ${formatMoneyBR(order?.total || 0)}`);
    doc.push('');
  });

  if (tabData?.couvert_fee) {
    doc.push(`Couvert (${tabData?.people_count || 1}x): ${formatMoneyBR(tabData.couvert_fee)}`);
  }

  doc.push(formatSection('Total Comanda', receiptWidth), 'bold');
  doc.push(`TOTAL: ${formatMoneyBR(tabData?.total || 0)}`, 'total');
  doc.push('');
  doc.push('Nao e valido como documento fiscal.');
  doc.push('Solicite o documento fiscal ao estabelecimento.');
  doc.push('');
  doc.push('Link Eats', 'bold');
  doc.push('www.linkeats.com.br');
  doc.push('');
  doc.push('');
  doc.push('');

  return doc.toDocument({ kind: 'tab', header_title: 'COMANDA' });
}

function buildFontSampleReceipt(scale, paperWidth = '58mm', options = {}) {
  const receiptWidth = getReceiptWidth(paperWidth);
  const doc = createStyledReceipt({ ...options, paperWidth, fontScale: scale });
  const label = getFontScaleLabel(scale);

  doc.push(formatSection('Amostra de Fonte', receiptWidth), 'bold');
  doc.push(`ESTABELECIMENTO: Link Eats Demo`, 'title');
  doc.push(`Tamanho: ${label} (${normalizeFontScale(scale)})`);
  doc.push(`Papel: ${paperWidth === '80mm' ? '80mm' : '58mm'}`);
  doc.push('');
  doc.push('1 un HAMBURGUER (R$ 25,00 - R$ 25,00)');
  doc.push('> adicional: BACON (R$ 4,00)');
  doc.push('');
  doc.push(formatSection('Pagamento', receiptWidth), 'bold');
  doc.push('Total de produtos: R$ 29,00');
  doc.push('TOTAL: R$ 29,00', 'total');
  doc.push('');
  doc.push('Ajuste o controle deslizante');
  doc.push('e imprima novamente ate');
  doc.push('ficar no tamanho ideal.');
  doc.push('');

  return doc.toDocument({ kind: 'font_sample', header_title: 'NOVO PEDIDO' });
}

function formatOrderText(order, companyName, options = {}) {
  return documentToPlainText(buildOrderReceipt(order, companyName, options));
}

function formatTabText(tabData, companyName, options = {}) {
  return documentToPlainText(buildTabReceipt(tabData, companyName, options));
}

function formatFontSampleText(scale, paperWidth = '58mm', options = {}) {
  return documentToPlainText(buildFontSampleReceipt(scale, paperWidth, options));
}

module.exports = {
  formatOrderText,
  formatTabText,
  formatFontSampleText,
  buildOrderReceipt,
  buildTabReceipt,
  buildFontSampleReceipt,
  documentToPlainText,
  normalizeFontScale,
  getFontScaleLabel,
  getReceiptWidth,
  ALLOWED_FONT_SCALES,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_LABELS,
};
