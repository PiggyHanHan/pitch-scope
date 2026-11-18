# 音准可视化 · 本地启动
# 用法：powershell -ExecutionPolicy Bypass -File .\start.ps1
#       （或右键“在终端中运行”）

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"

$candidates = @()
if ($env:CONDA_PREFIX) { $candidates += (Join-Path $env:CONDA_PREFIX "python.exe") }
$candidates += "E:\miniconda\python.exe"
$candidates += (Join-Path $env:USERPROFILE "miniconda3\python.exe")
$candidates += (Join-Path $env:USERPROFILE "anaconda3\python.exe")

$python = $null
foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) { $python = $path; break }
}
if (-not $python) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source }
}

if (-not $python) {
    Write-Host "[pitch-scope] Python 3.9+ was not found."
    Write-Host "Install Python, or run manually: python tools\serve.py"
    exit 1
}

& $python "tools\serve.py" @args
