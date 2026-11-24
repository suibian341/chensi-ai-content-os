param(
  [string]$DownloadBase = '__CHENSI_DOWNLOAD_BASE__'
)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:LOCALAPPDATA 'ChensiAI\JianyingCompanion'
$ProtocolRoot = 'HKCU:\Software\Classes\chensi-jianying'
$Files = @('companion.py', 'bridge.py', 'launch.ps1', 'uninstall.ps1', 'requirements.txt')

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
foreach ($File in $Files) {
  Invoke-WebRequest -UseBasicParsing -Uri ($DownloadBase.TrimEnd('/') + '/' + $File) -OutFile (Join-Path $InstallDir $File)
}

$Py = Get-Command py.exe -ErrorAction SilentlyContinue
if ($Py) {
  & $Py.Source -3 -m pip install --disable-pip-version-check -r (Join-Path $InstallDir 'requirements.txt')
} else {
  $Python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $Python) { throw '未找到 Python 3，请先安装 Python 后重新运行。' }
  & $Python.Source -m pip install --disable-pip-version-check -r (Join-Path $InstallDir 'requirements.txt')
}
if ($LASTEXITCODE -ne 0) { throw '剪映草稿依赖安装失败。' }

New-Item -Path $ProtocolRoot -Force | Out-Null
Set-Item -Path $ProtocolRoot -Value 'URL:Chensi Jianying Companion'
New-ItemProperty -Path $ProtocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$ProtocolRoot\DefaultIcon" -Force | Out-Null
Set-Item -Path "$ProtocolRoot\DefaultIcon" -Value 'powershell.exe,0'
New-Item -Path "$ProtocolRoot\shell\open\command" -Force | Out-Null
$Launcher = Join-Path $InstallDir 'launch.ps1'
$Command = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Launcher + '" "%1"'
Set-Item -Path "$ProtocolRoot\shell\open\command" -Value $Command

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('辰思AI本机剪映助手已安装。返回网页点击“绑定本机剪映”即可选择草稿目录。', '辰思AI本机剪映', 'OK', 'Information') | Out-Null

