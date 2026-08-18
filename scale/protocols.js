/**
 * Protocolos comuns de balanças comerciais (Brasil / PDV).
 * encode() gera o frame que a balança enviaria; decode() interpreta bytes recebidos.
 */

const STX = 0x02;
const ETX = 0x03;
const CR = 0x0d;
const LF = 0x0a;
const ENQ = 0x05;

function clampWeight(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 99.999);
}

function clampPricePerKg(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 9999.99);
}

/** PRT5: R$ 16,58 => 001658 (4 inteiros + 2 decimais) */
function encodeToledoPricePerKg(price) {
  const cents = Math.round(clampPricePerKg(price) * 100);
  const body = String(cents).padStart(6, '0').slice(-6);
  return Buffer.from([STX, ...Buffer.from(body, 'ascii'), ETX]);
}

function padWeight3(kg) {
  return clampWeight(kg).toFixed(3).padStart(7, '0'); // e.g. 001.250
}

function grams6(kg) {
  return String(Math.round(clampWeight(kg) * 1000)).padStart(6, '0').slice(-6);
}

/** Toledo Prix (PRT): STX + 5 chars + ETX, com ENQ (0x05).
 *  Dígitos = peso em gramas (01250 => 1.250 kg). IIIII = instável/inválido.
 *  Também aceita formato contínuo legado: STX + status + 6 dígitos + CR
 */
const toledo = {
  id: 'toledo',
  name: 'Toledo Prix (PRT/ENQ)',
  description: 'STX+5 dígitos+ETX @ 2400 (ENQ)',
  needsPoll: true,
  encodeRequest() {
    return Buffer.from([ENQ]);
  },
  encodePricePerKg(price) {
    return encodeToledoPricePerKg(price);
  },
  encode(kg, { stable = true } = {}) {
    if (!stable) {
      return Buffer.from([STX, ...Buffer.from('IIIII', 'ascii'), ETX]);
    }
    const body = String(Math.round(clampWeight(kg) * 1000)).padStart(5, '0').slice(-5);
    return Buffer.from([STX, ...Buffer.from(body, 'ascii'), ETX]);
  },
  createParser(onWeight) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      while (buf.length > 0) {
        const stx = buf.indexOf(STX);
        if (stx < 0) {
          buf = Buffer.alloc(0);
          return;
        }
        if (stx > 0) buf = buf.subarray(stx);

        // Formato Prix PRT: STX ... ETX
        const etx = buf.indexOf(ETX, 1);
        if (etx > 0) {
          const payload = buf.subarray(1, etx).toString('ascii');
          buf = buf.subarray(etx + 1);
          if (/^I+$/i.test(payload)) {
            onWeight({ kg: 0, stable: false, raw: payload, protocol: 'toledo' });
            continue;
          }
          if (/^\d{5,6}$/.test(payload)) {
            onWeight({
              kg: parseInt(payload, 10) / 1000,
              stable: true,
              raw: payload,
              protocol: 'toledo',
            });
            continue;
          }
          continue;
        }

        // Legado contínuo: STX + status + 6 dígitos + CR
        const cr = buf.indexOf(CR, 1);
        if (cr < 0) return;
        const payload = buf.subarray(1, cr).toString('ascii');
        buf = buf.subarray(cr + 1);
        const m = payload.match(/^([01])(\d{6})$/);
        if (m) {
          onWeight({
            kg: parseInt(m[2], 10) / 1000,
            stable: m[1] === '0',
            raw: payload,
            protocol: 'toledo',
          });
        }
      }
    };
  },
};

/** Filizola: STX + peso com ponto + ETX */
const filizola = {
  id: 'filizola',
  name: 'Filizola',
  description: 'STX + 0nn.nnn + ETX',
  encode(kg, { stable = true } = {}) {
    const w = padWeight3(kg); // 001.250
    const status = stable ? '0' : '1';
    return Buffer.from([STX, ...Buffer.from(status + w, 'ascii'), ETX]);
  },
  createParser(onWeight) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      while (buf.length > 0) {
        const stx = buf.indexOf(STX);
        if (stx < 0) {
          buf = Buffer.alloc(0);
          return;
        }
        if (stx > 0) buf = buf.subarray(stx);
        const etx = buf.indexOf(ETX, 1);
        if (etx < 0) return;
        const payload = buf.subarray(1, etx).toString('ascii');
        buf = buf.subarray(etx + 1);
        const m = payload.match(/^([01])(\d{3}\.\d{3})$/);
        if (m) {
          onWeight({
            kg: parseFloat(m[2]),
            stable: m[1] === '0',
            raw: payload,
            protocol: 'filizola',
          });
        }
      }
    };
  },
};

/** Urano / genérico ASCII: +0001.234\\r\\n */
const urano = {
  id: 'urano',
  name: 'Urano (ASCII)',
  description: '+0001.234 + CRLF',
  encode(kg) {
    const w = clampWeight(kg).toFixed(3).padStart(8, '0');
    return Buffer.from(`+${w}\r\n`, 'ascii');
  },
  createParser(onWeight) {
    let text = '';
    return (chunk) => {
      text += Buffer.from(chunk).toString('ascii');
      const parts = text.split(/\r\n|\n|\r/);
      text = parts.pop() || '';
      for (const line of parts) {
        const m = line.trim().match(/^[+\-]?\s*(\d+\.\d{1,3})$/);
        if (m) {
          onWeight({ kg: parseFloat(m[1]), stable: true, raw: line, protocol: 'urano' });
        }
      }
    };
  },
};

/** Elgin / estilo A&D: ST,GS,+0001.234kg\\r\\n */
const elgin = {
  id: 'elgin',
  name: 'Elgin / A&D',
  description: 'ST,GS,+0001.234kg',
  encode(kg, { stable = true } = {}) {
    const status = stable ? 'ST' : 'US';
    const w = clampWeight(kg).toFixed(3).padStart(8, '0');
    return Buffer.from(`${status},GS,+${w}kg\r\n`, 'ascii');
  },
  createParser(onWeight) {
    let text = '';
    return (chunk) => {
      text += Buffer.from(chunk).toString('ascii');
      const parts = text.split(/\r\n|\n|\r/);
      text = parts.pop() || '';
      for (const line of parts) {
        const m = line.match(/^(ST|US|OL),([A-Z]{2}),\s*([+\-])?\s*(\d+\.\d+)kg$/i);
        if (m) {
          onWeight({
            kg: parseFloat(m[4]) * (m[3] === '-' ? -1 : 1),
            stable: m[1].toUpperCase() === 'ST',
            raw: line,
            protocol: 'elgin',
          });
        }
      }
    };
  },
};

/** Protocolo por ENQ: host envia 0x05, balança responde STX+peso+ETX+CR */
const enq = {
  id: 'enq',
  name: 'ENQ / polling',
  description: 'Host envia ENQ (0x05), balança responde',
  needsPoll: true,
  encodeRequest() {
    return Buffer.from([ENQ]);
  },
  encode(kg, { stable = true } = {}) {
    const w = padWeight3(kg);
    const status = stable ? '0' : '1';
    return Buffer.from([STX, ...Buffer.from(status + w, 'ascii'), ETX, CR]);
  },
  createParser(onWeight) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      while (buf.length > 0) {
        const stx = buf.indexOf(STX);
        if (stx < 0) {
          buf = Buffer.alloc(0);
          return;
        }
        if (stx > 0) buf = buf.subarray(stx);
        const cr = buf.indexOf(CR, 1);
        if (cr < 0) return;
        const frame = buf.subarray(0, cr + 1);
        buf = buf.subarray(cr + 1);
        const etx = frame.indexOf(ETX);
        if (etx < 1) continue;
        const payload = frame.subarray(1, etx).toString('ascii');
        const m = payload.match(/^([01])(\d{3}\.\d{3})$/);
        if (m) {
          onWeight({
            kg: parseFloat(m[2]),
            stable: m[1] === '0',
            raw: payload,
            protocol: 'enq',
          });
        }
      }
    };
  },
};

/** Texto simples: 1.234\\n */
const simples = {
  id: 'simples',
  name: 'Texto simples',
  description: '1.234 + LF',
  encode(kg) {
    return Buffer.from(`${clampWeight(kg).toFixed(3)}\n`, 'ascii');
  },
  createParser(onWeight) {
    let text = '';
    return (chunk) => {
      text += Buffer.from(chunk).toString('ascii');
      const parts = text.split(/\r\n|\n|\r/);
      text = parts.pop() || '';
      for (const line of parts) {
        const m = line.trim().match(/^(\d+[.,]\d{1,3})$/);
        if (m) {
          onWeight({
            kg: parseFloat(m[1].replace(',', '.')),
            stable: true,
            raw: line,
            protocol: 'simples',
          });
        }
      }
    };
  },
};

const PROTOCOLS = {
  toledo,
  filizola,
  urano,
  elgin,
  enq,
  simples,
};

function listProtocols() {
  return Object.values(PROTOCOLS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    needsPoll: Boolean(p.needsPoll),
  }));
}

function getProtocol(id) {
  return PROTOCOLS[id] || null;
}

module.exports = {
  PROTOCOLS,
  listProtocols,
  getProtocol,
  ENQ,
  encodeToledoPricePerKg,
  clampPricePerKg,
};
