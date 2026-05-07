# -*- coding: utf-8 -*-
import sys
import json
import traceback
import platform
import unicodedata

# Fix stdout encoding for UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')

# Importa win32 apenas no Windows
IS_WINDOWS = platform.system() == 'Windows'
if IS_WINDOWS:
    try:
        import win32print
    except ImportError:
        IS_WINDOWS = False

# Função para listar todas as impressoras disponíveis
def listar_impressoras():
    if not IS_WINDOWS:
        return []
    try:
        impressoras = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        return [impressora[2] for impressora in impressoras]
    except Exception as e:
        return []

# Função para obter impressora padrão
def obter_impressora_padrao():
    if not IS_WINDOWS:
        return None
    try:
        return win32print.GetDefaultPrinter()
    except Exception:
        impressoras = listar_impressoras()
        return impressoras[0] if impressoras else None

# Converte texto com acentos para encoding compatível com impressoras térmicas
def encode_para_impressora(texto):
    # Tenta CP850 (padrão DOS/térmicas) primeiro
    try:
        return texto.encode('cp850')
    except (UnicodeEncodeError, LookupError):
        pass
    # Fallback: CP1252 (Windows Latin)
    try:
        return texto.encode('cp1252')
    except (UnicodeEncodeError, LookupError):
        pass
    # Último recurso: normaliza para ASCII removendo acentos
    normalizado = unicodedata.normalize('NFKD', texto)
    return normalizado.encode('ascii', errors='replace')

def montar_dados_impressao(texto, font_size='normal'):
    """
    Monta dados para impressão térmica com comandos ESC/POS
    font_size: 'compact', 'normal', 'medium', 'large'
    """
    dados_texto = encode_para_impressora(texto)
    
    # Inicializa impressora
    inicio = b'\x1b@'
    
    # Configura fonte e espaçamento conforme tamanho
    if font_size == 'large':
        # Fonte grande (altura dupla + espaçamento generoso)
        inicio += b'\x1bM\x00'      # Font A
        inicio += b'\x1b3\x25'      # Line spacing 37
        inicio += b'\x1d!\x10'      # Double height only
    elif font_size == 'medium':
        # Fonte média (tamanho médio + espaçamento generoso)
        inicio += b'\x1bM\x00'      # Font A
        inicio += b'\x1b3\x20'      # Line spacing 32
        inicio += b'\x1d!\x00'      # Normal size
    elif font_size == 'compact':
        # Fonte compacta (menor com bom espaçamento)
        inicio += b'\x1bM\x01'      # Font B (mais condensada)
        inicio += b'\x1b3\x18'      # Line spacing 24
        inicio += b'\x1d!\x00'      # Normal size
    else:  # normal
        # Fonte normal padrão (tamanho médio com espaçamento generoso)
        inicio += b'\x1bM\x00'      # Font A
        inicio += b'\x1b3\x20'      # Line spacing 32
        inicio += b'\x1d!\x00'      # Normal size
    
    # Reset para configuração padrão no final
    fim = b'\x1d!\x00\x1bE\x00\x1bM\x00\x1b2'
    
    return inicio + dados_texto + fim

# Função para imprimir um texto na impressora selecionada (modo RAW)
def imprimir_texto(texto, impressora_nome=None, font_size='normal'):
    if not IS_WINDOWS:
        return {"success": False, "error": "Impressão real disponível apenas no Windows. Use modo simulação."}
    
    try:
        if not impressora_nome:
            impressora_nome = obter_impressora_padrao()
        
        if not impressora_nome:
            return {"success": False, "error": "Nenhuma impressora disponível"}

        # Usa win32print RAW para enviar texto diretamente
        hPrinter = win32print.OpenPrinter(impressora_nome)
        try:
            hJob = win32print.StartDocPrinter(hPrinter, 1, ("Pedido Link Eats", None, "RAW"))
            try:
                win32print.StartPagePrinter(hPrinter)
                dados = montar_dados_impressao(texto, font_size)
                win32print.WritePrinter(hPrinter, dados)
                win32print.EndPagePrinter(hPrinter)
            finally:
                win32print.EndDocPrinter(hPrinter)
        finally:
            win32print.ClosePrinter(hPrinter)

        return {"success": True, "message": f"Impresso em '{impressora_nome}'"}
    except Exception as e:
        return {"success": False, "error": str(e)}

# Função para processar comandos via JSON
def processar_comando(comando):
    try:
        action = comando.get('action')
        
        if action == 'list_printers':
            impressoras = listar_impressoras()
            return {"success": True, "printers": impressoras}
        
        elif action == 'get_default_printer':
            impressora = obter_impressora_padrao()
            if impressora:
                return {"success": True, "printer": impressora}
            else:
                return {"success": False, "error": "Nenhuma impressora padrão encontrada"}
        
        elif action == 'print':
            texto = comando.get('text', '')
            impressora = comando.get('printer')
            font_size = comando.get('font_size', 'normal')
            resultado = imprimir_texto(texto, impressora, font_size)
            return resultado
        
        elif action == 'test':
            texto_teste = "=== TESTE DE IMPRESSÃO ===\n" \
                          "Link Eats - Sistema funcionando!\n" \
                          "Data: " + comando.get('date', '') + "\n" \
                          "=========================="
            resultado = imprimir_texto(texto_teste)
            return resultado
        
        else:
            return {"success": False, "error": f"Ação desconhecida: {action}"}
    
    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}

# Main loop para processar comandos via stdin
if __name__ == "__main__":
    # Modo de serviço: lê comandos JSON do stdin
    for linha in sys.stdin:
        try:
            comando = json.loads(linha.strip())
            resultado = processar_comando(comando)
            print(json.dumps(resultado), flush=True)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"JSON inválido: {str(e)}"}), flush=True)
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}), flush=True)
