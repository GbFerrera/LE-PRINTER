@echo off
setlocal enabledelayedexpansion

REM Run from repository root/electron-printer/scripts
cd /d "%~dp0.."

echo ===== Preparando ambiente Python =====
where py >nul 2>&1
if %errorlevel% neq 0 (
  echo Nao encontrei o launcher "py". Tentando "python".
  where python >nul 2>&1 || (
    echo ERRO: Python 3 nao encontrado no PATH. Instale o Python 3 antes de continuar.
    exit /b 1
  )
  set PYTHON=python
) else (
  set PYTHON=py -3
)

%PYTHON% -m pip install --upgrade pip
%PYTHON% -m pip install -r requirements.txt pyinstaller

echo ===== Gerando executavel da impressora =====
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build

%PYTHON% -m PyInstaller --onefile --noconsole ^
  --hidden-import=PIL ^
  --hidden-import=PIL.Image ^
  --hidden-import=PIL.ImageDraw ^
  --hidden-import=PIL.ImageFont ^
  --hidden-import=PIL.ImageEnhance ^
  --hidden-import=PIL.ImageWin ^
  --hidden-import=win32print ^
  --hidden-import=win32gui ^
  --hidden-import=win32con ^
  --hidden-import=win32ui ^
  --collect-all=pywin32 ^
  printer.py
if %errorlevel% neq 0 (
  echo ERRO: Falha ao gerar o executavel com PyInstaller.
  exit /b 1
)

if not exist bin mkdir bin
copy /y "dist\\printer.exe" "bin\\printer-win.exe" >nul
if %errorlevel% neq 0 (
  echo ERRO: Nao foi possivel copiar printer.exe para bin\\printer-win.exe
  exit /b 1
)

echo ===== Concluido =====
echo Arquivo gerado em: %cd%\\bin\\printer-win.exe
echo Agora rode: npm run build:win

exit /b 0

