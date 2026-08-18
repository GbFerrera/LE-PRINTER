const { EventEmitter } = require('events');
const { listProtocols, getProtocol } = require('./protocols');

let SerialPort;
try {
  ({ SerialPort } = require('serialport'));
} catch (error) {
  SerialPort = null;
  console.warn('[scale] serialport não disponível:', error.message);
}

const DETECT_BAUDS = [2400, 4800, 9600, 19200];
const DETECT_PROTOCOLS = ['toledo', 'filizola', 'enq', 'elgin', 'urano', 'simples'];

/**
 * Serviço de balança via porta serial real (sem simuladores).
 */
class ScaleService extends EventEmitter {
  constructor() {
    super();
    this.protocolId = 'toledo';
    this.running = false;
    this.mode = 'idle'; // idle | serial | detecting
    this.currentKg = 0;
    this.stable = false;
    this.portPath = null;
    this.baudRate = 2400;
    this.lastError = null;
    this.detected = false;
    this.pricePerKg = 0;
    this._pollTimer = null;
    this._port = null;
    this._parser = null;
    this._lastEmit = null;
  }

  listProtocols() {
    return listProtocols();
  }

  async listPorts() {
    if (!SerialPort) {
      return { ports: [], error: 'Módulo serialport não instalado/recompilado' };
    }
    try {
      const ports = await SerialPort.list();
      return {
        ports: ports.map((p) => ({
          path: p.path,
          manufacturer: p.manufacturer || '',
          friendlyName: p.friendlyName || p.path,
          vendorId: p.vendorId || '',
          productId: p.productId || '',
        })),
      };
    } catch (error) {
      return { ports: [], error: error.message };
    }
  }

  /** Prefere Prolific/CH340/FTDI; senão a primeira COM. */
  pickPreferredPort(ports) {
    if (!ports?.length) return null;
    const ranked = [...ports].sort((a, b) => {
      const score = (p) => {
        const t = `${p.friendlyName} ${p.manufacturer}`.toLowerCase();
        if (t.includes('prolific') || p.vendorId === '067B') return 0;
        if (t.includes('ch340') || p.vendorId === '1A86') return 1;
        if (t.includes('ftdi') || p.vendorId === '0403') return 2;
        if (t.includes('cp210') || p.vendorId === '10C4') return 3;
        return 9;
      };
      return score(a) - score(b);
    });
    return ranked[0].path;
  }

  getStatus() {
    const total = this.currentKg * this.pricePerKg;
    return {
      running: this.running,
      mode: this.mode,
      protocolId: this.protocolId,
      protocol: listProtocols().find((p) => p.id === this.protocolId) || null,
      kg: this.currentKg,
      stable: this.stable,
      pricePerKg: this.pricePerKg,
      total,
      portPath: this.portPath,
      baudRate: this.baudRate,
      lastError: this.lastError,
      detected: this.detected,
      serialAvailable: Boolean(SerialPort),
    };
  }

  setPricePerKg(price, { send = true } = {}) {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0) throw new Error('Preço inválido');
    this.pricePerKg = Math.min(n, 9999.99);
    const status = this.getStatus();
    this.emit('status', status);
    this.emit('weight', {
      kg: this.currentKg,
      stable: this.stable,
      protocol: this.protocolId,
      pricePerKg: this.pricePerKg,
      total: status.total,
      mode: this.mode,
      portPath: this.portPath,
      baudRate: this.baudRate,
      ts: Date.now(),
    });
    if (!send) return Promise.resolve({ ...status, sent: false });
    return this.sendPriceToScale().then((sent) => ({ ...status, ...sent }));
  }

  /**
   * Envia preço/kg (PRT5). Pausa o ENQ, espera ACK (0x06) ou NAK (0x15/0x21).
   */
  sendPriceToScale() {
    const proto = getProtocol(this.protocolId);
    if (!proto || typeof proto.encodePricePerKg !== 'function') {
      return Promise.resolve({
        success: false,
        sent: false,
        error: 'Protocolo não envia preço/kg (use Toledo PRT5)',
      });
    }
    if (!this._port || !this._port.isOpen) {
      return Promise.resolve({
        success: false,
        sent: false,
        error: 'Balança desconectada',
      });
    }

    const frame = proto.encodePricePerKg(this.pricePerKg);
    const port = this._port;

    return new Promise((resolve) => {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }

      let settled = false;
      const chunks = [];
      let timer = null;
      let earlyCheck = null;

      const onData = (buf) => chunks.push(Buffer.from(buf));

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (earlyCheck) clearInterval(earlyCheck);
        port.off('data', onData);
        this._restartPollingIfNeeded();
        resolve(result);
      };

      const evaluate = () => {
        const rx = Buffer.concat(chunks);
        if (rx.includes(0x06)) {
          finish({ success: true, sent: true, ack: true });
          return true;
        }
        if (rx.includes(0x15) || rx.includes(0x21)) {
          finish({
            success: false,
            sent: true,
            ack: false,
            error:
              'Balança rejeitou o preço (NAK). Em C13 use SERIAL e C14=PRT5. O total continua calculado no app.',
          });
          return true;
        }
        return false;
      };

      port.on('data', onData);

      earlyCheck = setInterval(() => {
        evaluate();
      }, 40);

      timer = setTimeout(() => {
        if (!evaluate()) {
          finish({
            success: false,
            sent: true,
            ack: false,
            error: 'Sem ACK da balança ao enviar preço. Total segue no app.',
          });
        }
      }, 1200);

      try {
        port.write(frame, (err) => {
          if (err) {
            finish({ success: false, sent: false, error: err.message });
          }
        });
      } catch (error) {
        finish({ success: false, sent: false, error: error.message });
      }
    });
  }

  _restartPollingIfNeeded() {
    if (this._pollTimer || !this.running || !this._port || !this._port.isOpen) return;
    const proto = getProtocol(this.protocolId);
    const shouldPoll = proto?.needsPoll || this.protocolId === 'toledo' || this.protocolId === 'enq';
    if (!shouldPoll) return;
    const request = typeof proto?.encodeRequest === 'function'
      ? () => proto.encodeRequest()
      : () => Buffer.from([0x05]);
    this._pollTimer = setInterval(() => {
      if (this._port && this._port.isOpen) {
        try {
          this._port.write(request());
        } catch {
          // ignore
        }
      }
    }, 400);
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._port) {
      try {
        if (this._port.isOpen) this._port.close();
      } catch {
        // ignore
      }
      this._port.removeAllListeners();
      this._port = null;
    }
    this.running = false;
    this.mode = 'idle';
    this._parser = null;
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  feedBytes(chunk) {
    if (this._parser) this._parser(chunk);
  }

  /**
   * Detecta baud + protocolo e conecta.
   * path opcional; se omitido, escolhe a melhor COM automaticamente.
   */
  async connectAuto({ path } = {}) {
    if (!SerialPort) {
      throw new Error('serialport não disponível');
    }

    this.stop();
    this.mode = 'detecting';
    this.lastError = null;
    this.detected = false;
    this.emit('status', this.getStatus());

    const { ports, error } = await this.listPorts();
    if (error) throw new Error(error);
    const chosen = path || this.pickPreferredPort(ports);
    if (!chosen) throw new Error('Nenhuma porta COM encontrada');

    let best = null;

    for (const baud of DETECT_BAUDS) {
      const probe = await this._probePort(chosen, baud);
      if (probe) {
        best = { path: chosen, ...probe };
        break;
      }
    }

    if (!best) {
      this.mode = 'idle';
      this.lastError = `Nenhuma resposta em ${chosen}. Confira cabo, C14/C15/C16 e peso.`;
      this.emit('status', this.getStatus());
      throw new Error(this.lastError);
    }

    this.detected = true;
    return this.startSerial({
      path: best.path,
      baudRate: best.baudRate,
      protocolId: best.protocolId,
    });
  }

  _probePort(path, baudRate) {
    return new Promise((resolve) => {
      const port = new SerialPort({
        path,
        baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false,
      });

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try {
          port.removeAllListeners();
          if (port.isOpen) port.close(() => resolve(result));
          else resolve(result);
        } catch {
          resolve(result);
        }
      };

      port.open((err) => {
        if (err) return finish(null);
        try {
          port.set({ dtr: true, rts: false });
        } catch {
          // ignore
        }

        let found = null;
        const parsers = DETECT_PROTOCOLS.map((id) => {
          const proto = getProtocol(id);
          if (!proto) return null;
          return {
            id,
            parser: proto.createParser((reading) => {
              if (found || !reading) return;
              // Aceita qualquer frame válido do protocolo (inclui 0,000 / IIIII da Toledo)
              found = { baudRate, protocolId: id, raw: reading.raw };
              finish(found);
            }),
          };
        }).filter(Boolean);

        const onData = (chunk) => {
          if (found) return;
          for (const entry of parsers) {
            try {
              entry.parser(chunk);
            } catch {
              // ignore
            }
            if (found) return;
          }
        };

        port.on('data', onData);

        let polls = 0;
        const poll = setInterval(() => {
          polls += 1;
          try {
            port.write(Buffer.from([0x05]));
            if (polls === 3) port.write(Buffer.from('P\r'));
          } catch {
            // ignore
          }
          if (polls >= 6) clearInterval(poll);
        }, 300);

        setTimeout(() => {
          clearInterval(poll);
          finish(found);
        }, 2200);
      });
    });
  }

  startSerial({ path, baudRate = 2400, protocolId } = {}) {
    if (!SerialPort) {
      return Promise.reject(new Error('serialport não disponível'));
    }
    if (!path) return Promise.reject(new Error('Informe a porta COM'));
    if (protocolId) {
      if (!getProtocol(protocolId)) {
        return Promise.reject(new Error(`Protocolo desconhecido: ${protocolId}`));
      }
      this.protocolId = protocolId;
    }

    const proto = getProtocol(this.protocolId);
    if (!proto) return Promise.reject(new Error('Protocolo inválido'));

    this.stop();
    this.mode = 'serial';
    this.running = true;
    this.lastError = null;
    this.portPath = path;
    this.baudRate = Number(baudRate) || 2400;
    this.currentKg = 0;
    this.stable = false;
    this._lastEmit = null;
    this._parser = proto.createParser((reading) => this._onParsed(reading));

    this._port = new SerialPort({
      path,
      baudRate: this.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });

    this._port.on('data', (chunk) => this.feedBytes(chunk));
    this._port.on('error', (err) => {
      this.lastError = err.message;
      this.emit('error', err);
      this.emit('status', this.getStatus());
    });
    this._port.on('close', () => {
      if (this.mode === 'serial' && this.running) {
        this.running = false;
        this.mode = 'idle';
        this.emit('status', this.getStatus());
      }
    });

    return new Promise((resolve, reject) => {
      this._port.open((err) => {
        if (err) {
          this.lastError = err.message;
          this.running = false;
          this.mode = 'idle';
          this._port = null;
          this.emit('error', err);
          this.emit('status', this.getStatus());
          reject(err);
          return;
        }
        try {
          this._port.set({ dtr: true, rts: false });
        } catch {
          // ignore
        }

        const shouldPoll = proto.needsPoll || this.protocolId === 'toledo' || this.protocolId === 'enq';
        if (shouldPoll) {
          const request = typeof proto.encodeRequest === 'function'
            ? () => proto.encodeRequest()
            : () => Buffer.from([0x05]);
          this._pollTimer = setInterval(() => {
            if (this._port && this._port.isOpen) {
              try {
                this._port.write(request());
              } catch {
                // ignore
              }
            }
          }, 400);
        }

        const status = this.getStatus();
        this.emit('status', status);
        if (this.pricePerKg > 0) {
          this.sendPriceToScale();
        }
        resolve(status);
      });
    });
  }

  _onParsed(reading) {
    const kg = Number(reading.kg);
    if (!Number.isFinite(kg)) return;

    this.currentKg = kg;
    this.stable = Boolean(reading.stable);
    const total = this.currentKg * this.pricePerKg;

    const payload = {
      kg,
      stable: this.stable,
      protocol: reading.protocol || this.protocolId,
      raw: reading.raw || null,
      pricePerKg: this.pricePerKg,
      total,
      mode: this.mode,
      portPath: this.portPath,
      baudRate: this.baudRate,
      ts: Date.now(),
    };

    const key = `${payload.kg.toFixed(3)}|${payload.stable}|${payload.protocol}|${this.pricePerKg.toFixed(2)}`;
    if (key !== this._lastEmit) {
      this._lastEmit = key;
      this.emit('weight', payload);
    }
  }
}

module.exports = { ScaleService };
