# Aplica icon.ico no .exe empacotado (necessário quando signAndEditExecutable=false).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "dist\win-unpacked\Link Eats Printer.exe"
$icon = Join-Path $root "icon.ico"
$rcedit = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe"

if (-not (Test-Path -LiteralPath $exe)) {
  throw "EXE nao encontrado: $exe (rode o pack antes)"
}
if (-not (Test-Path -LiteralPath $icon)) {
  throw "Icone nao encontrado: $icon"
}
if (-not (Test-Path -LiteralPath $rcedit)) {
  throw "rcedit nao encontrado: $rcedit"
}

Write-Host "Aplicando icone em: $exe"
& $rcedit $exe --set-icon $icon
if ($LASTEXITCODE -ne 0) {
  throw "rcedit falhou com codigo $LASTEXITCODE"
}
Write-Host "Icone aplicado com sucesso."
