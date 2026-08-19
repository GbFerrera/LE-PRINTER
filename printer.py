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
HAS_WIN32PRINT = False
HAS_WIN32GUI = False
if IS_WINDOWS:
    try:
        import win32print
        import win32con
        HAS_WIN32PRINT = True
    except ImportError:
        pass
    try:
        import win32gui
        HAS_WIN32GUI = True
    except ImportError:
        pass

try:
    from PIL import Image, ImageDraw, ImageFont, ImageEnhance
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    ImageEnhance = None

try:
    from PIL import ImageWin
    HAS_IMAGEWIN = True
except ImportError:
    HAS_IMAGEWIN = False


def listar_impressoras():
    if not HAS_WIN32PRINT:
        return []
    try:
        impressoras = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        return [impressora[2] for impressora in impressoras]
    except Exception:
        return []


def obter_impressora_padrao():
    if not HAS_WIN32PRINT:
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


# 1–5: GDI supersample. 6–8: caminho especial (ESC*/fatias) — POS58 falha em bitmap grande via GDI.
ESCALAS_FONTE_PERMITIDAS = (1, 2, 3, 4, 5, 6, 7, 8)
ESCALA_FONTE_PADRAO = 4
ESCALA_GRANDE_MIN = 6  # a partir daqui usa pipeline de fonte grande


def normalizar_escala_fonte(valor):
    mapa_legado = {
        'compact': 3,
        'normal': 4,
        'medium': 5,
        'medium_large': 7,
        'large': 8,
    }
    if isinstance(valor, str):
        chave = valor.strip().lower()
        if chave in mapa_legado:
            return mapa_legado[chave]
        try:
            valor = int(chave)
        except ValueError:
            return ESCALA_FONTE_PADRAO
    try:
        escala = int(valor)
    except (TypeError, ValueError):
        return ESCALA_FONTE_PADRAO

    melhor = ESCALAS_FONTE_PERMITIDAS[0]
    melhor_dist = abs(escala - melhor)
    for candidata in ESCALAS_FONTE_PERMITIDAS:
        dist = abs(escala - candidata)
        if dist < melhor_dist:
            melhor = candidata
            melhor_dist = dist
    return melhor


def obter_largura_imagem(paper_width):
    return 576 if str(paper_width).lower() == '80mm' else 384


# Supersample 2x (prática comum em térmica/PIL) — nitidez sem MinFilter (que deixava tudo "negrito")
RENDER_SCALE = 2


def calcular_tamanhos_fonte(font_scale, render_scale=1):
    escala = normalizar_escala_fonte(font_scale)
    normal = max(8, int(round((12 + escala * 2.6) * render_scale)))
    return {
        'normal': normal,
        'title': max(8, int(round(normal * 1.22))),
        'bold': max(8, int(round(normal * 1.06))),
        'total': max(8, int(round(normal * 1.18))),
        'blank': max(8, int(round(normal * 0.42))),
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
            # title/bold/total = Arial Bold; corpo = regular
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


def _configurar_draw_termico(draw, mono=False):
    """fontmode L no supersample; mono ('1') nas fontes grandes (traço sólido)."""
    try:
        draw.fontmode = '1' if mono else 'L'
    except Exception:
        pass
    return draw


def _largura_texto(texto, fonte, draw):
    bbox = draw.textbbox((0, 0), texto, font=fonte, anchor='lt')
    return max(0, bbox[2] - bbox[0])


def _altura_linha(fonte, draw):
    try:
        ascent, descent = fonte.getmetrics()
        return max(12, int(ascent + descent + 2))
    except Exception:
        bbox = draw.textbbox((0, 0), 'AgÁy', font=fonte, anchor='lt')
        return max(12, bbox[3] - bbox[1] + 2)


def _desenhar_texto(draw, xy, texto, fonte, tamanho_px=20, negrito=False):
    """Desenha texto. Negrito = fonte bold; sem stroke (stroke engrossa tudo)."""
    _ = tamanho_px
    _ = negrito
    draw.text(xy, texto, font=fonte, fill=0, anchor='lt')


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


def _preparar_linhas_desenho(documento, render_scale=RENDER_SCALE):
    paper_width = documento.get('paper_width', '58mm')
    font_scale = documento.get('font_scale', ESCALA_FONTE_PADRAO)
    base_width = obter_largura_imagem(paper_width)
    img_width = base_width * render_scale
    margin_x = 12 * render_scale
    content_width = img_width - (margin_x * 2)
    tamanhos = calcular_tamanhos_fonte(font_scale, render_scale=render_scale)
    mono = render_scale <= 1

    temp_img = Image.new('L', (img_width, 200), 255)
    draw = _configurar_draw_termico(ImageDraw.Draw(temp_img), mono=mono)
    fontes = carregar_fontes(tamanhos)

    desenho = []
    for item in documento.get('lines', []):
        estilo = item.get('style', 'normal')
        texto = item.get('text', '')

        if estilo == 'blank' or texto == '':
            desenho.append({'kind': 'blank', 'height': tamanhos['blank']})
            continue

        fonte = _fonte_para_estilo(fontes, estilo)
        tamanho_px = {
            'title': tamanhos['title'],
            'bold': tamanhos['bold'],
            'total': tamanhos['total'],
        }.get(estilo, tamanhos['normal'])
        negrito = estilo in ('title', 'bold', 'total')

        for linha in quebrar_texto(texto, fonte, draw, content_width):
            altura = _altura_linha(fonte, draw)
            padding = max(4 * render_scale, int(tamanhos['normal'] * 0.20))
            desenho.append({
                'kind': 'text',
                'text': linha,
                'font': fonte,
                'size_px': tamanho_px,
                'bold': negrito,
                'height': altura + padding,
            })

    return desenho, img_width, margin_x, tamanhos, base_width


def _desenhar_cabecalho(img, draw, img_width, y_offset, titulo='NOVO PEDIDO', tamanhos=None, render_scale=RENDER_SCALE):
    """Cabeçalho só com texto (sem logo) — ex: NOVO PEDIDO."""
    _configurar_draw_termico(draw, mono=(render_scale <= 1))
    margin_x = 12 * render_scale
    titulo = str(titulo or 'NOVO PEDIDO').strip().upper() or 'NOVO PEDIDO'

    title_size = int((tamanhos or {}).get('title', 22))
    header_size = max(16 * render_scale, min(30 * render_scale, int(title_size * 0.95)))
    fontes_header = carregar_fontes({
        'normal': header_size,
        'title': header_size,
        'bold': header_size,
        'total': header_size,
    })
    fonte_titulo = fontes_header['title']

    disponivel = max(40 * render_scale, img_width - (margin_x * 2))
    text_width = _largura_texto(titulo, fonte_titulo, draw)
    if text_width > disponivel:
        menor = max(12 * render_scale, int(header_size * disponivel / text_width))
        fontes_header = carregar_fontes({
            'normal': menor, 'title': menor, 'bold': menor, 'total': menor,
        })
        fonte_titulo = fontes_header['title']
        header_size = menor
        text_width = _largura_texto(titulo, fonte_titulo, draw)

    text_height = _altura_linha(fonte_titulo, draw)
    text_x = max(margin_x, (img_width - text_width) // 2)
    _desenhar_texto(draw, (text_x, y_offset), titulo, fonte_titulo, header_size, negrito=True)

    linha_y = y_offset + text_height + (6 * render_scale)
    draw.line((margin_x, linha_y, img_width - margin_x, linha_y), fill=0, width=max(1, render_scale))
    return linha_y + (10 * render_scale)


def _para_bitmap_termico(img, target_width=None):
    """Pipeline usado por apps térmicos: contraste + nitidez + limiar (sem MinFilter).

    MinFilter engrossava todos os pixels e parecia 'tudo em negrito'.
    Supersample + limiar mantém títulos bold (fonte) e corpo normal.
    """
    if img.mode != 'L':
        img = img.convert('L')

    if ImageEnhance is not None:
        img = ImageEnhance.Contrast(img).enhance(1.4)
        img = ImageEnhance.Sharpness(img).enhance(1.8)

    mono = img.point(lambda p: 0 if p < 145 else 255, 'L')

    if target_width and mono.width != target_width:
        new_h = max(1, int(round(mono.height * target_width / mono.width)))
        mono = mono.resize((target_width, new_h), Image.Resampling.NEAREST if hasattr(Image, 'Resampling') else Image.NEAREST)

    return mono.convert('1')


def _render_scale_para_documento(documento):
    """Fontes grandes: 1x + mono (GDI da POS58 costuma apagar supersample alto)."""
    escala = normalizar_escala_fonte(documento.get('font_scale', ESCALA_FONTE_PADRAO))
    return 1 if escala >= ESCALA_GRANDE_MIN else RENDER_SCALE


def renderizar_cupom_imagem(documento, logo_path=None):
    """Renderiza cupom em imagem (supersample 2x → limiar), sem logo."""
    if not HAS_PIL:
        raise RuntimeError('Pillow não instalado')

    _ = logo_path
    render_scale = _render_scale_para_documento(documento)
    desenho, img_width, margin_x, tamanhos, base_width = _preparar_linhas_desenho(
        documento, render_scale=render_scale
    )
    header_title = documento.get('header_title') or 'NOVO PEDIDO'
    header_reserva = 80 * render_scale
    altura_estimada = header_reserva + sum(item['height'] for item in desenho) + (100 * render_scale)

    mono = render_scale <= 1
    img = Image.new('L', (img_width, max(altura_estimada, 200 * render_scale)), 255)
    draw = _configurar_draw_termico(ImageDraw.Draw(img), mono=mono)
    y = 8 * render_scale
    y = _desenhar_cabecalho(
        img, draw, img_width, y,
        titulo=header_title,
        tamanhos=tamanhos,
        render_scale=render_scale,
    )

    for item in desenho:
        if item['kind'] == 'blank':
            y += item['height']
            continue
        if y + item['height'] + (20 * render_scale) > img.height:
            nova = Image.new('L', (img_width, y + item['height'] + (160 * render_scale)), 255)
            nova.paste(img, (0, 0))
            img = nova
            draw = _configurar_draw_termico(ImageDraw.Draw(img), mono=mono)
        _desenhar_texto(
            draw, (margin_x, y), item['text'], item['font'],
            item.get('size_px', tamanhos['normal']),
            negrito=bool(item.get('bold')),
        )
        y += item['height']

    img = img.crop((0, 0, img_width, min(y + (24 * render_scale), img.height)))
    # Fontes grandes: limiar um pouco mais baixo para não “sumir” traços
    if mono:
        if img.mode != 'L':
            img = img.convert('L')
        if ImageEnhance is not None:
            img = ImageEnhance.Contrast(img).enhance(1.5)
            img = ImageEnhance.Sharpness(img).enhance(2.0)
        img = img.point(lambda p: 0 if p < 170 else 255, 'L')
        if img.width != base_width:
            nearest = Image.Resampling.NEAREST if hasattr(Image, 'Resampling') else Image.NEAREST
            new_h = max(1, int(round(img.height * base_width / img.width)))
            img = img.resize((base_width, new_h), nearest)
        return img.convert('1')
    return _para_bitmap_termico(img, target_width=base_width)


# POS58 barata: ESC * m=1. Elgin/Bematech etc.: GS v 0 (mais limpo, sem “risco” nas letras).
ESC_STAR_BAND_HEIGHT = 8
ESC_STAR_MODE = 1
GS_V0_MAX_HEIGHT = 255


def _pixel_preto(valor):
    return valor == 0


def _impressora_escpos_nativa(impressora_nome):
    """Impressoras que entendem ESC/POS de verdade (Elgin i9, etc.)."""
    nome = str(impressora_nome or '').lower()
    return any(k in nome for k in (
        'elgin', 'i9', 'i7', 'i8', 'bematech', 'daruma', 'epson', 'tm-',
    ))


def _obter_horzres_impressora(impressora_nome):
    if not (HAS_WIN32GUI and HAS_WIN32PRINT and impressora_nome):
        return 0
    import ctypes
    try:
        hdc = win32gui.CreateDC('WINSPOOL', impressora_nome, None)
    except Exception:
        return 0
    if not hdc:
        return 0
    try:
        return int(ctypes.windll.gdi32.GetDeviceCaps(hdc, win32con.HORZRES) or 0)
    finally:
        win32gui.DeleteDC(hdc)


def detectar_paper_width_dispositivo(impressora_nome, preferido='58mm'):
    """Alinha bobina à resolução real do driver (POS58 em Elgin reporta 384 even em 80mm)."""
    horz = _obter_horzres_impressora(impressora_nome)
    if horz >= 500:
        return '80mm'
    if horz >= 300:
        return '58mm'
    return '80mm' if str(preferido).lower() == '80mm' else '58mm'


def _largura_max_imagem(paper_width='58mm'):
    return 576 if str(paper_width).lower() == '80mm' else 384


def _preparar_imagem_impressao(img, paper_width='58mm', target_width=None):
    """Normaliza imagem 1-bit na largura correta do papel (evita overflow → lixo)."""
    max_w = int(target_width) if target_width else _largura_max_imagem(paper_width)
    max_w = max(96, max_w)
    # Largura múltipla de 8 (raster ESC/POS)
    max_w = max_w - (max_w % 8)
    if img.mode != '1':
        img = _para_bitmap_termico(img, target_width=max_w)
    w, h = img.size
    if w != max_w:
        novo_h = max(1, int(round(h * max_w / max(w, 1))))
        nearest = Image.Resampling.NEAREST if hasattr(Image, 'Resampling') else Image.NEAREST
        img = img.resize((max_w, novo_h), nearest).convert('1')
    # Altura múltipla de 8 — ESC * / GS v 0
    w, h = img.size
    pad = (8 - (h % 8)) % 8
    if pad:
        canvas = Image.new('1', (w, h + pad), 1)
        canvas.paste(img, (0, 0))
        img = canvas
    return img


def imagem_para_escpos_star(img, paper_width='58mm', target_width=None):
    """RAW via ESC * m=1 (8 dots) — melhor em clones POS58."""
    img = _preparar_imagem_impressao(img, paper_width, target_width=target_width)
    largura, altura = img.size
    pix = img.load()
    out = bytearray()
    out += bytes([0x1B, 0x33, ESC_STAR_BAND_HEIGHT])

    for y0 in range(0, altura, ESC_STAR_BAND_HEIGHT):
        nL = largura & 0xFF
        nH = (largura >> 8) & 0xFF
        out += bytes([0x1B, 0x2A, ESC_STAR_MODE, nL, nH])
        for x in range(largura):
            byte = 0
            for bit in range(8):
                y = y0 + bit
                if y < altura and _pixel_preto(pix[x, y]):
                    byte |= (0x80 >> bit)
            out.append(byte)
        out += bytes([0x1B, 0x4A, ESC_STAR_BAND_HEIGHT])

    out += b'\x1b2'
    return bytes(out)


def imagem_para_escpos_gs_v0(img, paper_width='58mm', target_width=None):
    """RAW via GS v 0 — Elgin i9 e compatíveis (letras limpas, sem risco no meio)."""
    img = _preparar_imagem_impressao(img, paper_width, target_width=target_width)
    largura, altura = img.size
    width_bytes = (largura + 7) // 8
    out = bytearray()

    for y0 in range(0, altura, GS_V0_MAX_HEIGHT):
        band_h = min(GS_V0_MAX_HEIGHT, altura - y0)
        faixa = img.crop((0, y0, largura, y0 + band_h))
        pix = faixa.load()
        xL = width_bytes & 0xFF
        xH = (width_bytes >> 8) & 0xFF
        yL = band_h & 0xFF
        yH = (band_h >> 8) & 0xFF
        out += bytes([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH])
        for y in range(band_h):
            for xb in range(width_bytes):
                byte = 0
                for bit in range(8):
                    x = xb * 8 + bit
                    if x < largura and _pixel_preto(pix[x, y]):
                        byte |= (0x80 >> bit)
                out.append(byte)
    return bytes(out)


def imagem_para_escpos(img, paper_width='58mm', target_width=None, nativa=False):
    if nativa:
        return imagem_para_escpos_gs_v0(img, paper_width, target_width=target_width)
    return imagem_para_escpos_star(img, paper_width, target_width=target_width)


def _devmode_retrato_termica(impressora_nome, paper_width='58mm'):
    """Força Retrato + largura do bobina no DEVMODE (muitos drivers 80mm vêm em Landscape)."""
    hprinter = win32print.OpenPrinter(impressora_nome)
    try:
        try:
            info = win32print.GetPrinter(hprinter, 2)
            dm = info.get('pDevMode')
        except Exception:
            dm = None
        if dm is None:
            return None

        # 1 = portrait, 2 = landscape
        try:
            dm.Orientation = getattr(win32con, 'DMORIENT_PORTRAIT', 1)
            fields = int(getattr(dm, 'Fields', 0) or 0)
            fields |= getattr(win32con, 'DM_ORIENTATION', 0x1)
            # Largura do papel em décimos de mm (80mm → 800)
            is_80 = str(paper_width).lower() == '80mm'
            dm.PaperWidth = 800 if is_80 else 580
            dm.PaperLength = max(int(getattr(dm, 'PaperLength', 0) or 0), 3000)
            dm.PaperSize = getattr(win32con, 'DMPAPER_USER', 256)
            fields |= getattr(win32con, 'DM_PAPERWIDTH', 0x100)
            fields |= getattr(win32con, 'DM_PAPERLENGTH', 0x200)
            fields |= getattr(win32con, 'DM_PAPERSIZE', 0x2)
            dm.Fields = fields
        except Exception:
            return None
        return dm
    finally:
        win32print.ClosePrinter(hprinter)


def _criar_dc_impressora(impressora_nome, paper_width='58mm'):
    """Cria HDC com DEVMODE em retrato quando possível."""
    dm = _devmode_retrato_termica(impressora_nome, paper_width)
    hdc = None
    if dm is not None:
        try:
            hdc = win32gui.CreateDC('WINSPOOL', impressora_nome, dm)
        except Exception as e:
            print(f'DC com DEVMODE falhou, fallback: {e}', flush=True)
            hdc = None
    if not hdc:
        hdc = win32gui.CreateDC('WINSPOOL', impressora_nome, None)
    return hdc


def imprimir_imagem_gdi(img, impressora_nome, paper_width='58mm', max_slice=None):
    """Imprime bitmap via driver Windows (GDI / win32gui).

    Drivers 80mm costumam abrir DC em Landscape → cupom sai 'na horizontal'.
    Aqui forçamos Retrato no DEVMODE e, se o eixo ainda vier trocado, rotacionamos o bitmap.
    """
    import ctypes
    from ctypes import wintypes

    if not (HAS_WIN32PRINT and HAS_WIN32GUI and HAS_PIL and HAS_IMAGEWIN):
        raise RuntimeError('GDI indisponível (pywin32/Pillow)')

    # Usa largura real do driver (evita esticar 576→384 e “riscar” letra)
    horz = _obter_horzres_impressora(impressora_nome)
    expected_w = _largura_max_imagem(paper_width)
    print_w = horz if horz >= 300 else expected_w
    print_w = print_w - (print_w % 8)
    img = _preparar_imagem_impressao(img, paper_width, target_width=print_w)
    # 1-bit puro — RGB/halftone no GDI térmico causa risco no meio das letras
    img_mono = img.convert('1')
    expected_w = print_w

    class DOCINFO(ctypes.Structure):
        _fields_ = [
            ('cbSize', ctypes.c_int),
            ('lpszDocName', wintypes.LPCWSTR),
            ('lpszOutput', wintypes.LPCWSTR),
            ('lpszDatatype', wintypes.LPCWSTR),
            ('fwType', ctypes.c_uint),
        ]

    gdi32 = ctypes.windll.gdi32
    hdc = _criar_dc_impressora(impressora_nome, paper_width)
    if not hdc:
        raise RuntimeError(f'Não foi possível abrir DC da impressora {impressora_nome}')

    try:
        page_w = int(gdi32.GetDeviceCaps(hdc, win32con.HORZRES) or 0)
        page_h = int(gdi32.GetDeviceCaps(hdc, win32con.VERTRES) or 0)
        print(
            f'GDI caps paper={paper_width} HORZRES={page_w} VERTRES={page_h} expected_w={expected_w}',
            flush=True,
        )

        # Landscape residual: largura do DC >> altura e a "altura" ≈ largura da bobina.
        # Ex.: HORZRES=2000+, VERTRES≈576 → texto sai de lado na 80mm.
        landscape_dc = (
            page_w > 0 and page_h > 0
            and page_w > page_h
            and page_h <= int(expected_w * 1.35)
        )
        if landscape_dc:
            print('GDI landscape detectado — rotacionando bitmap 90°', flush=True)
            img_mono = img_mono.transpose(Image.ROTATE_90)

        if max_slice is None:
            max_slice = 1200
        max_slice = max(64, int(max_slice))
        if page_w <= 0:
            page_w = img_mono.size[0]
        if page_h <= 0:
            page_h = max_slice

        if landscape_dc:
            slice_limit = min(page_w, max_slice)
        else:
            slice_limit = min(page_h, max_slice)
        slice_limit = max(8, slice_limit - (slice_limit % 8))

        src_w, src_h = img_mono.size
        across = page_h if landscape_dc else page_w
        if across <= 0:
            across = expected_w

        if landscape_dc:
            if 0 < across < src_h:
                target_h = across - (across % 8) if across >= 8 else across
                target_w = max(1, int(src_w * target_h / max(src_h, 1)))
                img_mono = img_mono.resize((target_w, target_h), Image.NEAREST).convert('1')
            else:
                target_w, target_h = src_w, src_h
        else:
            # 1:1 com HORZRES — stretch GDI é o que “risca” o meio da letra
            if src_w != across and across > 0:
                target_w = across - (across % 8) if across >= 8 else across
                target_h = max(1, int(round(src_h * target_w / max(src_w, 1))))
                img_mono = img_mono.resize((target_w, target_h), Image.NEAREST).convert('1')
            else:
                target_w, target_h = src_w, src_h

        black_pixels = sum(1 for px in img_mono.convert('L').histogram()[:128])
        if black_pixels < 50:
            raise RuntimeError(f'Bitmap sem texto (black_pixels={black_pixels})')

        COLORONCOLOR = 3

        def _job_faixa(faixa_img, box):
            di = DOCINFO(ctypes.sizeof(DOCINFO), 'Pedido Link Eats', None, None, 0)
            if gdi32.StartDocW(hdc, ctypes.byref(di)) <= 0:
                raise RuntimeError('StartDoc falhou')
            try:
                if gdi32.StartPage(hdc) <= 0:
                    raise RuntimeError('StartPage falhou')
                try:
                    try:
                        gdi32.SetStretchBltMode(hdc, COLORONCOLOR)
                    except Exception:
                        pass
                    dib = ImageWin.Dib(faixa_img.convert('1'))
                    dib.draw(hdc, box)
                finally:
                    gdi32.EndPage(hdc)
            finally:
                gdi32.EndDoc(hdc)

        if landscape_dc:
            if target_w <= slice_limit:
                _job_faixa(img_mono, (0, 0, target_w, target_h))
                return 'gdi-single-landscape'
            x = 0
            while x < target_w:
                slice_w = min(slice_limit, target_w - x)
                faixa = img_mono.crop((x, 0, x + slice_w, target_h))
                _job_faixa(faixa, (0, 0, slice_w, target_h))
                x += slice_w
            return 'gdi-multidoc-landscape'

        if target_h <= slice_limit:
            _job_faixa(img_mono, (0, 0, target_w, target_h))
            return 'gdi-single'
        y = 0
        while y < target_h:
            slice_h = min(slice_limit, target_h - y)
            faixa = img_mono.crop((0, y, target_w, y + slice_h))
            _job_faixa(faixa, (0, 0, target_w, slice_h))
            y += slice_h
        return 'gdi-multidoc'
    finally:
        win32gui.DeleteDC(hdc)


def _imprimir_raw_escpos(dados, impressora_nome):
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


def _comandos_corte_papel():
    """Avança o papel e aciona a guilhotina (GS V 0 — corte total)."""
    return b'\n\n\n\n\n\n' + b'\x1d\x56\x00'


def cortar_papel(impressora_nome):
    """Envia corte via RAW (necessário após impressão GDI, que não manda ESC/POS)."""
    if not HAS_WIN32PRINT or not impressora_nome:
        return False
    try:
        _imprimir_raw_escpos(_comandos_corte_papel(), impressora_nome)
        return True
    except Exception as e:
        print(f"Corte de papel falhou: {e}", flush=True)
        return False


def montar_dados_impressao_imagem(documento, logo_path=None, impressora_nome=None):
    paper_width = documento.get('paper_width', '58mm')
    nativa = _impressora_escpos_nativa(impressora_nome)
    horz = _obter_horzres_impressora(impressora_nome) if impressora_nome else 0
    target_w = horz if horz >= 300 else None
    if target_w:
        # Re-render na largura real do dispositivo evita squash 576→384
        efetivo = detectar_paper_width_dispositivo(impressora_nome, paper_width)
        doc2 = dict(documento)
        doc2['paper_width'] = efetivo
        img = renderizar_cupom_imagem(doc2, None)
        paper_width = efetivo
    else:
        img = renderizar_cupom_imagem(documento, None)
    raster = imagem_para_escpos(img, paper_width, target_width=target_w, nativa=nativa)
    inicio = b'\x1b@' + b'\x1ba\x00' + b'\x1d!\x00' + b'\x1bE\x00'
    fim = _comandos_corte_papel()
    return inicio + raster + fim


# mag: nibble baixo = largura, nibble alto = altura (0 = 1x).
# Evita double-width agressivo na POS58 (estoura linha e vira lixo).
ESCALAS_FONTE = {
    1:  {'font_b': True,  'mag': 0x00, 'spacing': 16},
    2:  {'font_b': True,  'mag': 0x00, 'spacing': 20},
    3:  {'font_b': True,  'mag': 0x00, 'spacing': 24},
    4:  {'font_b': False, 'mag': 0x00, 'spacing': 28},
    5:  {'font_b': False, 'mag': 0x00, 'spacing': 32},
    6:  {'font_b': False, 'mag': 0x10, 'spacing': 36},  # só altura 2x
    7:  {'font_b': False, 'mag': 0x10, 'spacing': 40},
    8:  {'font_b': False, 'mag': 0x11, 'spacing': 44},  # 2x2 — rewrap
    9:  {'font_b': False, 'mag': 0x11, 'spacing': 48},
    10: {'font_b': False, 'mag': 0x22, 'spacing': 52},
}


def obter_config_fonte(font_size='normal'):
    escala = normalizar_escala_fonte(font_size)
    return ESCALAS_FONTE.get(escala, ESCALAS_FONTE[5])


def _largura_chars_papel(paper_width, mag=0x00):
    base = 48 if str(paper_width).lower() == '80mm' else 32
    width_mult = (int(mag) & 0x0F) + 1
    return max(8, base // width_mult)


def _reflow_texto(texto, largura):
    saida = []
    for linha in str(texto or '').splitlines():
        raw = linha.rstrip('\r')
        if raw == '':
            saida.append('')
            continue
        # Mantém linhas curtas; quebra as longas sem cortar no meio se possível
        while len(raw) > largura:
            corte = raw.rfind(' ', 0, largura + 1)
            if corte <= 0:
                corte = largura
            saida.append(raw[:corte].rstrip())
            raw = raw[corte:].lstrip()
        saida.append(raw)
    return '\n'.join(saida)


def documento_para_texto(documento):
    """Converte receipt estruturado em texto puro (sem bitmap/logo)."""
    paper_width = documento.get('paper_width', '58mm')
    font_scale = documento.get('font_scale', 5)
    config = obter_config_fonte(font_scale)
    largura = _largura_chars_papel(paper_width, config['mag'])

    linhas = []
    titulo = str(documento.get('header_title') or 'NOVO PEDIDO').strip().upper()
    if titulo:
        linhas.append(titulo)
        linhas.append('=' * largura)

    for item in documento.get('lines') or []:
        estilo = item.get('style', 'normal')
        texto = item.get('text', '')
        if estilo == 'blank' or texto == '':
            linhas.append('')
            continue
        linhas.append(str(texto))

    return _reflow_texto('\n'.join(linhas) + '\n', largura)


def montar_dados_impressao_texto(texto, font_size='normal', logo_path=None, paper_width='58mm'):
    # Fallback texto (sem logo). Cupons estruturados usam renderização por imagem.
    _ = logo_path
    config = obter_config_fonte(font_size)
    largura = _largura_chars_papel(paper_width, config['mag'])
    texto_ajustado = _reflow_texto(texto, largura)
    dados_texto = encode_para_impressora(texto_ajustado)

    inicio = b'\x1b@' + b'\x1ba\x00'
    inicio += b'\x1bM\x01' if config['font_b'] else b'\x1bM\x00'
    inicio += bytes([0x1b, 0x33, config['spacing'] & 0xFF])
    inicio += bytes([0x1d, 0x21, config['mag'] & 0xFF])
    fim = b'\x1d!\x00\x1bE\x00\x1bM\x00\x1b2'
    return inicio + dados_texto + fim + _comandos_corte_papel()


def imprimir_documento(documento, impressora_nome=None, logo_path=None):
    """Imprime cupom em imagem (controle fino da fonte), sem logo.

    1–5: GDI fatias normais.
    6–8: GDI em fatias bem menores (POS58 apaga bitmap denso em página alta);
         se falhar, tenta fatias ainda menores e só então RAW ESC*.
    """
    if not HAS_WIN32PRINT:
        return {"success": False, "error": "Impressão real disponível apenas no Windows. Use modo simulação."}

    if not HAS_PIL:
        return {"success": False, "error": "Pillow não instalado. Execute: pip install Pillow"}

    try:
        if not impressora_nome:
            impressora_nome = obter_impressora_padrao()
        if not impressora_nome:
            return {"success": False, "error": "Nenhuma impressora disponível"}

        preferido = documento.get('paper_width', '58mm')
        paper_width = detectar_paper_width_dispositivo(impressora_nome, preferido)
        escala = normalizar_escala_fonte(documento.get('font_scale', ESCALA_FONTE_PADRAO))
        doc_print = dict(documento)
        doc_print['paper_width'] = paper_width
        nativa = _impressora_escpos_nativa(impressora_nome)
        img = renderizar_cupom_imagem(doc_print, None)

        # Elgin/i9: RAW GS v 0 primeiro (GDI+driver POS58 “risca” o meio das letras)
        if nativa:
            try:
                dados = montar_dados_impressao_imagem(doc_print, None, impressora_nome)
                _imprimir_raw_escpos(dados, impressora_nome)
                return {
                    "success": True,
                    "message": f"Impresso em '{impressora_nome}' (ESC/POS)",
                    "mode": "raw-gsv0",
                    "font_scale": escala,
                    "cut": True,
                    "paper_width": paper_width,
                }
            except Exception as raw_error:
                print(f"RAW Elgin falhou, tentando GDI: {raw_error}", flush=True)

        if HAS_IMAGEWIN and HAS_WIN32GUI:
            try:
                modo = imprimir_imagem_gdi(img, impressora_nome, paper_width, max_slice=2400)
                cortou = cortar_papel(impressora_nome)
                return {
                    "success": True,
                    "message": f"Impresso em '{impressora_nome}'",
                    "mode": modo or "gdi",
                    "font_scale": escala,
                    "cut": cortou,
                    "paper_width": paper_width,
                }
            except Exception as gdi_error:
                print(f"GDI falhou, tentando RAW ESC*: {gdi_error}", flush=True)

        dados = montar_dados_impressao_imagem(doc_print, None, impressora_nome)
        _imprimir_raw_escpos(dados, impressora_nome)

        return {
            "success": True,
            "message": f"Impresso em '{impressora_nome}' (RAW)",
            "mode": "raw",
            "font_scale": escala,
            "cut": True,
            "paper_width": paper_width,
        }
    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def imprimir_texto(texto, impressora_nome=None, font_size='normal', logo_path=None, paper_width='58mm'):
    if not HAS_WIN32PRINT:
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
                dados = montar_dados_impressao_texto(texto, font_size, None, paper_width)
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
        paper_width = comando.get('paper_width', '58mm')
        impressora = comando.get('printer')
        receipt = comando.get('receipt')

        if action == 'print':
            if receipt and isinstance(receipt, dict) and receipt.get('lines'):
                if receipt.get('font_scale') is None:
                    receipt['font_scale'] = font_size
                if not receipt.get('paper_width'):
                    receipt['paper_width'] = paper_width
                return imprimir_documento(receipt, impressora, None)

            texto = comando.get('text', '')
            return imprimir_texto(texto, impressora, font_size, None, paper_width)

        if action == 'test':
            if receipt and isinstance(receipt, dict) and receipt.get('lines'):
                if receipt.get('font_scale') is None:
                    receipt['font_scale'] = font_size
                if not receipt.get('paper_width'):
                    receipt['paper_width'] = paper_width
                return imprimir_documento(receipt, None, None)

            texto_teste = comando.get('text') or (
                "=== TESTE DE IMPRESSÃO ===\n"
                "Link Eats - Sistema funcionando!\n"
                "Data: " + comando.get('date', '') + "\n"
                "=========================="
            )
            return imprimir_texto(texto_teste, None, font_size, None, paper_width)

        if action == 'cut':
            impressora_corte = impressora or obter_impressora_padrao()
            if not impressora_corte:
                return {"success": False, "error": "Nenhuma impressora disponível"}
            cortou = cortar_papel(impressora_corte)
            return {
                "success": cortou,
                "message": "Corte enviado para a impressora" if cortou else "Corte não disponível nesta impressora",
                "cut": cortou,
            }

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
