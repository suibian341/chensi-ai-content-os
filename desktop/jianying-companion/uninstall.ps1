$ErrorActionPreference = 'Stop'
$ProtocolRoot = 'HKCU:\Software\Classes\chensi-jianying'
$InstallDir = Join-Path $env:LOCALAPPDATA 'ChensiAI\JianyingCompanion'

if (Test-Path $ProtocolRoot) { Remove-Item -LiteralPath $ProtocolRoot -Recurse -Force }
if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('辰思AI本机剪映助手已卸载。', '辰思AI本机剪映', 'OK', 'Information') | Out-Null

