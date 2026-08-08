# -*- coding: utf-8 -*-
import sys
import json
import traceback
import platform
import unicodedata
import os

# Fix stdout encoding for UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')

IS_WINDOWS = platform.system() == 'Windows'
if IS_WINDOWS:
    try:
        import win32print
    except ImportError:
        IS_WINDOWS = False

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def listar_impressoras():
    if not IS_WINDOWS:
        return []
    try:
        impressoras = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        return [impressora[2] for impressora in impressoras]
    except Exception:
        return []


def obter_impressora_padrao():
    if not IS_WINDOWS:
        return None
    try:
        return win32print.GetDefaultPrinter()
    except Exception:
        impressoras = listar_impressoras()
        return impressoras[0] if impressoras else None


def encode_para_impressora(texto):
    try:
        return texto.encode('cp850')
    except (UnicodeEncodeError, LookupError):
        pass
    try:
        return texto.encode('cp1252')
    except (UnicodeEncodeError, LookupError):
        pass
    normalizado = unicodedata.normalize('NFKD', texto)
    return normalizado.encode('ascii', errors='replace')


def normalizar_escala_fonte(valor):
    mapa_legado = {
        'compact': 3,
        'normal': 5,
        'medium': 6,
        'medium_large': 8,
        'large': 9,
    }
    if isinstance(valor, str):
        chave = valor.strip().lower()
        if chave in mapa_legado:
            return mapa_legado[chave]
        try:
            valor = int(chave)
        except ValueError:
            return 5
    try:
        escala = int(valor)
    except (TypeError, ValueError):
        return 5
    return max(1, min(10, escala))


def obter_largura_imagem(paper_width):
    return 576 if str(paper_width).lower() == '80mm' else 384


def calcular_tamanhos_fonte(font_scale):
    escala = normalizar_escala_fonte(font_scale)
    normal = int(12 + escala * 2.6)
    return {
        'normal': normal,
        'title': int(normal * 1.22),
        'bold': int(normal * 1.06),
        'total': int(normal * 1.18),
        'blank': max(8, int(normal * 0.42)),
    }


def _candidatos_fonte():
    if IS_WINDOWS:
        win = os.environ.get('WINDIR', 'C:/Windows')
        fonts = os.path.join(win, 'Fonts')
        return [
            (os.path.join(fonts, 'arialbd.ttf'), os.path.join(fonts, 'arial.ttf')),
            (os.path.join(fonts, 'segoeuib.ttf'), os.path.join(fonts, 'segoeui.ttf')),
            (os.path.join(fonts, 'tahomabd.ttf'), os.path.join(fonts, 'tahoma.ttf')),
        ]
    if platform.system() == 'Darwin':
        return [
            ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'),
            ('/Library/Fonts/Arial Bold.ttf', '/Library/Fonts/Arial.ttf'),
        ]
    return [
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
        ('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'),
    ]


def carregar_fontes(tamanhos):
    if not HAS_PIL:
        raise RuntimeError('Pillow não instalado')

    for bold_path, regular_path in _candidatos_fonte():
        if os.path.exists(bold_path) and os.path.exists(regular_path):
            return {
                'normal': ImageFont.truetype(regular_path, tamanhos['normal']),
                'title': ImageFont.truetype(bold_path, tamanhos['title']),
                'bold': ImageFont.truetype(bold_path, tamanhos['bold']),
                'total': ImageFont.truetype(bold_path, tamanhos['total']),
            }

    fallback = ImageFont.load_default()
    return {
        'normal': fallback,
        'title': fallback,
        'bold': fallback,
        'total': fallback,
    }


def _fonte_para_estilo(fontes, estilo):
    if estilo == 'title':
        return fontes['title']
    if estilo == 'total':
        return fontes['total']
    if estilo == 'bold':
        return fontes['bold']
    return fontes['normal']


def _largura_texto(texto, fonte, draw):
    bbox = draw.textbbox((0, 0), texto, font=fonte)
    return max(0, bbox[2] - bbox[0])


def _altura_linha(fonte, draw):
    bbox = draw.textbbox((0, 0), 'Ag', font=fonte)
    return max(12, bbox[3] - bbox[1])


def quebrar_texto(texto, fonte, draw, largura_max):
    palavras = str(texto or '').split()
    if not palavras:
        return ['']

    linhas = []
    atual = ''
    for palavra in palavras:
        candidato = f'{atual} {palavra}'.strip()
        if _largura_texto(candidato, fonte, draw) <= largura_max:
            atual = candidato
            continue
        if atual:
            linhas.append(atual)
        if _largura_texto(palavra, fonte, draw) <= largura_max:
            atual = palavra
        else:
            pedaco = ''
            for char in palavra:
                teste = pedaco + char
                if _largura_texto(teste, fonte, draw) <= largura_max:
                    pedaco = teste
                else:
                    if pedaco:
                        linhas.append(pedaco)
                    pedaco = char
            atual = pedaco
    if atual:
        linhas.append(atual)
    return linhas or ['']


def _preparar_linhas_desenho(documento):
    paper_width = documento.get('paper_width', '58mm')
    font_scale = documento.get('font_scale', 5)
    img_width = obter_largura_imagem(paper_width)
    margin_x = 12
    content_width = img_width - (margin_x * 2)
    tamanhos = calcular_tamanhos_fonte(font_scale)

    temp_img = Image.new('L', (img_width, 200), 255)
    draw = ImageDraw.Draw(temp_img)
    fontes = carregar_fontes(tamanhos)

    desenho = []
    for item in documento.get('lines', []):
        estilo = item.get('style', 'normal')
        texto = item.get('text', '')

        if estilo == 'blank' or texto == '':
            desenho.append({'kind': 'blank', 'height': tamanhos['blank']})
            continue

        fonte = _fonte_para_estilo(fontes, estilo)
        for linha in quebrar_texto(texto, fonte, draw, content_width):
            altura = _altura_linha(fonte, draw)
            desenho.append({
                'kind': 'text',
                'text': linha,
                'font': fonte,
                'height': altura + max(2, int(tamanhos['normal'] * 0.18)),
            })

    return desenho, img_width, margin_x, tamanhos


def _desenhar_logo(img, draw, logo_path, img_width, y_offset):
    if not logo_path or not os.path.exists(logo_path) or not HAS_PIL:
        return y_offset

    try:
        logo = Image.open(logo_path).convert('L')
        largura_max = img_width - 24
        w, h = logo.size
        if w > largura_max:
            h = max(1, int(h * largura_max / w))
            w = largura_max
            logo = logo.resize((w, h), Image.LANCZOS)

        logo = logo.point(lambda x: 0 if x < 160 else 255, '1')
        x = max(0, (img_width - w) // 2)
        img.paste(logo, (x, y_offset))
        return y_offset + h + 12
    except Exception:
        return y_offset


def renderizar_cupom_imagem(documento, logo_path=None):
    if not HAS_PIL:
        raise RuntimeError('Pillow não instalado')

    desenho, img_width, margin_x, tamanhos = _preparar_linhas_desenho(documento)
    logo_reserva = 120 if logo_path and os.path.exists(logo_path) else 0
    altura_estimada = logo_reserva + sum(
        item['height'] if item['kind'] == 'text' else item['height']
        for item in desenho
    ) + 40

    img = Image.new('L', (img_width, max(altura_estimada, 120)), 255)
    draw = ImageDraw.Draw(img)
    y = 8
    y = _desenhar_logo(img, draw, logo_path, img_width, y)

    for item in desenho:
        if item['kind'] == 'blank':
            y += item['height']
            continue
        draw.text((margin_x, y), item['text'], font=item['font'], fill=0)
        y += item['height']

    img = img.crop((0, 0, img_width, min(y + 24, img.height)))
    return img.convert('1')


def imagem_para_escpos(img):
    img = img.convert('1')
    largura, altura = img.size
    width_bytes = (largura + 7) // 8
    padded_width = width_bytes * 8

    if padded_width != largura:
        padded = Image.new('1', (padded_width, altura), 1)
        padded.paste(img, (0, 0))
        img = padded
        largura = padded_width

    pixels = []
    for y in range(altura):
        for x_byte in range(width_bytes):
            byte = 0
            for bit in range(8):
                x = x_byte * 8 + bit
                if img.getpixel((x, y)) == 0:
                    byte |= (1 << (7 - bit))
            pixels.append(byte)

    xL = width_bytes & 0xFF
    xH = (width_bytes >> 8) & 0xFF
    yL = altura & 0xFF
    yH = (altura >> 8) & 0xFF
    return b'\x1d\x76\x30\x00' + bytes([xL, xH, yL, yH]) + bytes(pixels)


def montar_dados_impressao_imagem(documento, logo_path=None):
    img = renderizar_cupom_imagem(documento, logo_path)
    raster = imagem_para_escpos(img)
    inicio = b'\x1b@' + b'\x1ba\x00'
    fim = b'\n\n\n\n\n\n\x1dV\x00'
    return inicio + raster + fim


ESCALAS_FONTE = {
    1:  {'font_b': True,  'mag': 0x00, 'spacing': 16},
    2:  {'font_b': True,  'mag': 0x00, 'spacing': 20},
    3:  {'font_b': True,  'mag': 0x00, 'spacing': 24},
    4:  {'font_b': False, 'mag': 0x00, 'spacing': 28},
    5:  {'font_b': False, 'mag': 0x00, 'spacing': 32},
    6:  {'font_b': False, 'mag': 0x01, 'spacing': 34},
    7:  {'font_b': False, 'mag': 0x11, 'spacing': 36},
    8:  {'font_b': False, 'mag': 0x11, 'spacing': 40},
    9:  {'font_b': False, 'mag': 0x22, 'spacing': 44},
    10: {'font_b': False, 'mag': 0x33, 'spacing': 48},
}


def obter_config_fonte(font_size='normal'):
    escala = normalizar_escala_fonte(font_size)
    return ESCALAS_FONTE.get(escala, ESCALAS_FONTE[5])


def logo_para_escpos(logo_path, paper_width):
    if not logo_path or not os.path.exists(logo_path) or not HAS_PIL:
        return b''
    try:
        doc = {'paper_width': paper_width, 'font_scale': 5, 'lines': []}
        img = renderizar_cupom_imagem(doc, logo_path)
        return imagem_para_escpos(img) + b'\n'
    except Exception:
        return b''


def montar_dados_impressao_texto(texto, font_size='normal', logo_path=None, paper_width='58mm'):
    dados_texto = encode_para_impressora(texto)
    logo_bytes = logo_para_escpos(logo_path, paper_width)

    config = obter_config_fonte(font_size)
    inicio = b'\x1b@' + b'\x1ba\x00'
    inicio += b'\x1bM\x01' if config['font_b'] else b'\x1bM\x00'
    inicio += bytes([0x1b, 0x33, config['spacing'] & 0xFF])
    inicio += bytes([0x1d, 0x21, config['mag'] & 0xFF])
    fim = b'\x1d!\x00\x1bE\x00\x1bM\x00\x1b2'
    corte = b'\n\n\n\n\n\n\x1dV\x00'
    return inicio + logo_bytes + dados_texto + fim + corte


def imprimir_documento(documento, impressora_nome=None, logo_path=None):
    if not IS_WINDOWS:
        return {"success": False, "error": "Impressão real disponível apenas no Windows. Use modo simulação."}

    if not HAS_PIL:
        return {"success": False, "error": "Pillow não instalado. Execute: pip install -r requirements.txt"}

    try:
        if not impressora_nome:
            impressora_nome = obter_impressora_padrao()
        if not impressora_nome:
            return {"success": False, "error": "Nenhuma impressora disponível"}

        dados = montar_dados_impressao_imagem(documento, logo_path)
        hPrinter = win32print.OpenPrinter(impressora_nome)
        try:
            hJob = win32print.StartDocPrinter(hPrinter, 1, ("Pedido Link Eats", None, "RAW"))
            try:
                win32print.StartPagePrinter(hPrinter)
                win32print.WritePrinter(hPrinter, dados)
                win32print.EndPagePrinter(hPrinter)
            finally:
                win32print.EndDocPrinter(hPrinter)
        finally:
            win32print.ClosePrinter(hPrinter)

        return {"success": True, "message": f"Impresso em '{impressora_nome}'"}
    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def imprimir_texto(texto, impressora_nome=None, font_size='normal', logo_path=None, paper_width='58mm'):
    if not IS_WINDOWS:
        return {"success": False, "error": "Impressão real disponível apenas no Windows. Use modo simulação."}

    try:
        if not impressora_nome:
            impressora_nome = obter_impressora_padrao()
        if not impressora_nome:
            return {"success": False, "error": "Nenhuma impressora disponível"}

        hPrinter = win32print.OpenPrinter(impressora_nome)
        try:
            hJob = win32print.StartDocPrinter(hPrinter, 1, ("Pedido Link Eats", None, "RAW"))
            try:
                win32print.StartPagePrinter(hPrinter)
                dados = montar_dados_impressao_texto(texto, font_size, logo_path, paper_width)
                win32print.WritePrinter(hPrinter, dados)
                win32print.EndPagePrinter(hPrinter)
            finally:
                win32print.EndDocPrinter(hPrinter)
        finally:
            win32print.ClosePrinter(hPrinter)

        return {"success": True, "message": f"Impresso em '{impressora_nome}'"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def processar_comando(comando):
    try:
        action = comando.get('action')

        if action == 'list_printers':
            return {"success": True, "printers": listar_impressoras()}

        if action == 'get_default_printer':
            impressora = obter_impressora_padrao()
            if impressora:
                return {"success": True, "printer": impressora}
            return {"success": False, "error": "Nenhuma impressora padrão encontrada"}

        font_size = comando.get('font_scale', comando.get('font_size', 5))
        logo_path = comando.get('logo_path')
        paper_width = comando.get('paper_width', '58mm')
        impressora = comando.get('printer')
        receipt = comando.get('receipt')

        if action == 'print':
            if receipt and isinstance(receipt, dict) and receipt.get('lines'):
                if receipt.get('font_scale') is None:
                    receipt['font_scale'] = font_size
                if not receipt.get('paper_width'):
                    receipt['paper_width'] = paper_width
                return imprimir_documento(receipt, impressora, logo_path)

            texto = comando.get('text', '')
            return imprimir_texto(texto, impressora, font_size, logo_path, paper_width)

        if action == 'test':
            if receipt and isinstance(receipt, dict) and receipt.get('lines'):
                if receipt.get('font_scale') is None:
                    receipt['font_scale'] = font_size
                if not receipt.get('paper_width'):
                    receipt['paper_width'] = paper_width
                return imprimir_documento(receipt, None, logo_path)

            texto_teste = comando.get('text') or (
                "=== TESTE DE IMPRESSÃO ===\n"
                "Link Eats - Sistema funcionando!\n"
                "Data: " + comando.get('date', '') + "\n"
                "=========================="
            )
            return imprimir_texto(texto_teste, None, font_size, logo_path, paper_width)

        return {"success": False, "error": f"Ação desconhecida: {action}"}

    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


if __name__ == "__main__":
    for linha in sys.stdin:
        try:
            comando = json.loads(linha.strip())
            resultado = processar_comando(comando)
            print(json.dumps(resultado), flush=True)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"JSON inválido: {str(e)}"}), flush=True)
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}), flush=True)
