$ErrorActionPreference = 'Stop'
$CompanionPath = Join-Path $PSScriptRoot 'companion.py'
$ProtocolUrl = $args[0]

if (-not $ProtocolUrl) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('缺少辰思AI剪映导入链接。', '辰思AI本机剪映', 'OK', 'Error') | Out-Null
  exit 1
}

$Pyw = Get-Command pyw.exe -ErrorAction SilentlyContinue
if ($Pyw) {
  & $Pyw.Source -3 $CompanionPath $ProtocolUrl
  exit $LASTEXITCODE
}

$Pythonw = Get-Command pythonw.exe -ErrorAction SilentlyContinue
if ($Pythonw) {
  & $Pythonw.Source $CompanionPath $ProtocolUrl
  exit $LASTEXITCODE
}

$Python = Get-Command python.exe -ErrorAction SilentlyContinue
if ($Python) {
  & $Python.Source $CompanionPath $ProtocolUrl
  exit $LASTEXITCODE
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('未找到 Python 3，请先安装 Python 后重新运行本机助手安装程序。', '辰思AI本机剪映', 'OK', 'Error') | Out-Null
exit 1

