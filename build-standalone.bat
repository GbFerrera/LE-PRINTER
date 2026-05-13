@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  Link Eats Printer - Build Standalone
echo ========================================
echo.

REM Navegar para o diretório do script
cd /d "%~dp0"

REM Verificar se Node.js está instalado
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERRO: Node.js nao encontrado. Instale o Node.js antes de continuar.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

REM Verificar se Python está instalado
where py >nul 2>&1
if %errorlevel% neq 0 (
    echo Nao encontrei o launcher "py". Tentando "python"...
    where python >nul 2>&1
    if %errorlevel% neq 0 (
        echo ERRO: Python 3 nao encontrado. Instale o Python 3 antes de continuar.
        echo Download: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    set PYTHON=python
) else (
    set PYTHON=py -3
)

echo [1/4] Verificando dependencias Node.js...
if not exist node_modules (
    echo Instalando dependencias Node.js...
    call npm install
    if %errorlevel% neq 0 (
        echo ERRO: Falha ao instalar dependencias Node.js
        pause
        exit /b 1
    )
) else (
    echo Dependencias Node.js ja instaladas.
)

echo.
echo [2/4] Instalando dependencias Python...
%PYTHON% -m pip install --upgrade pip --quiet
%PYTHON% -m pip install pyinstaller pywin32 --quiet
if %errorlevel% neq 0 (
    echo ERRO: Falha ao instalar dependencias Python
    pause
    exit /b 1
)

echo.
echo [3/4] Compilando motor de impressao Python...
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build

%PYTHON% -m PyInstaller --onefile --noconsole printer.py
if %errorlevel% neq 0 (
    echo ERRO: Falha ao compilar printer.py
    pause
    exit /b 1
)

if not exist bin mkdir bin
copy /y "dist\printer.exe" "bin\printer-win.exe" >nul
if %errorlevel% neq 0 (
    echo ERRO: Falha ao copiar printer.exe
    pause
    exit /b 1
)

REM Limpar arquivos temporários do PyInstaller
rmdir /s /q dist
rmdir /s /q build
del /q printer.spec 2>nul

echo.
echo [4/4] Gerando executavel do aplicativo...
call npm run build:win:portable
if %errorlevel% neq 0 (
    echo ERRO: Falha ao gerar executavel do aplicativo
    pause
    exit /b 1
)

echo.
echo ========================================
echo  BUILD CONCLUIDO COM SUCESSO!
echo ========================================
echo.
echo O executavel portatil foi gerado em:
echo %cd%\dist\
echo.
echo Voce pode compactar a pasta gerada e distribuir.
echo O usuario so precisa descompactar e executar o .exe
echo.
pause
