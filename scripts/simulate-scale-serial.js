#!/usr/bin/env node
/**
 * Simula uma balança escrevendo frames numa porta COM.
 *
 * Uso com par virtual (com0com / VSPE / etc.):
 *   1. Crie um par COM3 <-> COM4
 *   2. No app: Conectar serial em COM3 (mesmo baud/protocolo)
 *   3. Neste terminal:
 *        node scripts/simulate-scale-serial.js --port COM4 --protocol toledo --kg 1.250
 *
 * Opções:
 *   --port COM4
 *   --protocol toledo|filizola|urano|elgin|enq|simples
 *   --kg 1.250
 *   --baud 9600
 *   --list          lista portas
 */

const { SerialPort } = require('serialport');
const { getProtocol, listProtocols } = require('../scale/protocols');

function parseArgs(argv) {
  const out = {
    port: null,
    protocol: 'toledo',
    kg: 1.25,
    baud: 9600,
    list: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--protocol') out.protocol = argv[++i];
    else if (a === '--kg') out.kg = Number(argv[++i]);
    else if (a === '--baud') out.baud = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Simulador de balança via Serial Port

Protocolos: ${listProtocols().map((p) => p.id).join(', ')}

Exemplos:
  node scripts/simulate-scale-serial.js --list
  node scripts/simulate-scale-serial.js --port COM4 --protocol elgin --kg 2.500
  node scripts/simulate-scale-serial.js --port COM4 --protocol toledo --baud 9600
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  if (args.list) {
    const ports = await SerialPort.list();
    if (!ports.length) {
      console.log('Nenhuma porta serial encontrada.');
      return;
    }
    for (const p of ports) {
      console.log(`${p.path}\t${p.friendlyName || p.manufacturer || ''}`);
    }
    return;
  }

  if (!args.port) {
    usage();
    console.error('Erro: informe --port COMx');
    process.exit(1);
  }

  const proto = getProtocol(args.protocol);
  if (!proto) {
    console.error('Protocolo inválido:', args.protocol);
    process.exit(1);
  }

  let current = 0;
  let settleMs = 0;
  const tickMs = 120;
  const target = Number.isFinite(args.kg) ? Math.max(0, args.kg) : 1.25;

  const port = new SerialPort({
    path: args.port,
    baudRate: args.baud || 9600,
    autoOpen: false,
  });

  port.open((err) => {
    if (err) {
      console.error('Falha ao abrir', args.port, err.message);
      console.error('Dica: use um par virtual (com0com). App lê uma ponta, este script escreve na outra.');
      process.exit(1);
    }

    console.log(`Simulando ${proto.name} em ${args.port} @ ${args.baud} baud → alvo ${target.toFixed(3)} kg`);
    console.log('Ctrl+C para parar');

    // Protocolo ENQ: responde quando o host pede
    if (proto.needsPoll) {
      port.on('data', (chunk) => {
        if (Buffer.from(chunk).includes(0x05)) {
          const stable = settleMs >= 900;
          port.write(proto.encode(current, { stable }));
        }
      });
    }

    setInterval(() => {
      const gap = target - current;
      current = Math.max(0, current + gap * 0.35 + (Math.random() - 0.5) * 0.015);
      const near = Math.abs(target - current) < 0.008;
      if (near) {
        settleMs += tickMs;
        current = target + (Math.random() - 0.5) * 0.002;
      } else {
        settleMs = 0;
      }
      const stable = settleMs >= 900;

      if (!proto.needsPoll) {
        port.write(proto.encode(current, { stable }));
      }

      process.stdout.write(`\r ${current.toFixed(3)} kg ${stable ? 'ESTÁVEL' : 'instável'}   `);
    }, tickMs);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
