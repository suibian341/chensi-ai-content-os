$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$public = Join-Path $root 'web/public'
$artifacts = Join-Path $root 'artifacts'
$gbk = [Text.Encoding]::GetEncoding(936)
$utf8 = New-Object Text.UTF8Encoding($false)
$files = @('workspace.html', 'admin.html', 'index.html', 'login.html')

function Reverse-Mojibake([string]$source) {
  $value = [Text.Encoding]::UTF8.GetString($gbk.GetBytes($source))
  return $value.Replace(([string][char]0xFEFF), '').Replace(([string][char]0xFFFD), '')
}

function Repair-CommonMarkup([string]$text) {
  $text = $text -replace '\?/(?=[A-Za-z])', '</'
  $text = $text -replace '\?>', '">'
  $text = $text -replace '\?\s*/>', '" />'
  $text = $text -replace '(?m)(</?(?:span|div|button|label|select|input|textarea|p|h[1-6]|strong|small|a|nav|section|option|li|ul|main|header|footer|aside|form|article|i|b|s|em|title|meta)[^>]*?)\?(?=\s*(?:>|</))', '$1'
  $text = $text -replace '(?m)(<[^>]+?)\?(?=\s*/?>)', '$1'
  return $text
}

function Add-Suffix([string]$text, [int[]]$prefixCodes, [int[]]$suffixCodes) {
  $prefix = -join ($prefixCodes | ForEach-Object { [char]$_ })
  $suffix = -join ($suffixCodes | ForEach-Object { [char]$_ })
  return $text.Replace($prefix, $prefix + $suffix)
}

function Repair-Workspace([string]$text) {
  $text = Add-Suffix $text (0x5185,0x5BB9,0x521B,0x4F5C,0x4E0E,0x8D26,0x53F7,0x7BA1) (0x7406)
  $text = Add-Suffix $text (0x521B,0x4F5C,0x5DE5,0x4F5C) (0x53F0)
  $text = Add-Suffix $text (0x4E3B,0x5BFC) (0x822A)
  $text = Add-Suffix $text (0x521B,0x4F5C,0x4E0E,0x8D26) (0x53F7)
  $text = Add-Suffix $text (0x751F,0x4EA7,0x4E0E,0x53D1) (0x5E03)
  $text = Add-Suffix $text (0x5A92,0x4F53,0x5B9E,0x9A8C) (0x5BA4)
  $text = Add-Suffix $text (0x6587,0x6848) (0x5E93)
  $text = Add-Suffix $text (0x7D20,0x6750) (0x5E93)
  $text = Add-Suffix $text (0x8D26,0x53F7,0x4E0E,0x56E2) (0x961F)
  $text = Add-Suffix $text (0x5DE5,0x5355,0x4E0E,0x6743) (0x76CA)
  $text = Add-Suffix $text (0x5B9A,0x5236,0x9700) (0x6C42)
  $text = Add-Suffix $text (0x672C,0x5730,0x6570,0x636E,0x5DE5,0x4F5C) (0x53F0)
  $text = Add-Suffix $text (0x9000,0x51FA,0x767B) (0x5F55)
  $text = Add-Suffix $text (0x5C0F,0x7EA2) (0x4E66)
  $text = Add-Suffix $text (0x540E,0x53F0,0x914D) (0x7F6E)
  $text = Add-Suffix $text (0x9879,0x76EE,0x72B6,0x6001,0x6458) (0x8981)
  $text = Add-Suffix $text (0x8D44,0x6599,0x4E0E,0x5B9A) (0x4F4D)
  $text = Add-Suffix $text (0x5BF9,0x6807,0x4E0E,0x62C6) (0x89E3)
  $text = Add-Suffix $text (0x6587,0x6848,0x4E0E,0x5EFA) (0x751F,0x6210)
  $text = Add-Suffix $text (0x6210,0x7247,0x4E0E,0x53D1) (0x5E03)
  $text = Add-Suffix $text (0x5F85,0x5F00) (0x59CB)
  $text = Add-Suffix $text (0x5F85,0x751F) (0x6210)
  $text = Add-Suffix $text (0x5DEE,0x5F02,0x5316,0x8868) (0x8FBE)
  $text = Add-Suffix $text (0x53EF,0x6301,0x7EED,0x5185,0x5BB9,0x65B9) (0x5411)
  $text = Add-Suffix $text (0x5E73,0x53F0,0x641C,0x7D22) (0x8BCD)
  $text = Add-Suffix $text (0x8D26,0x53F7,0x7C7B) (0x578B)
  return $text
}

function Repair-Admin([string]$text) { return $text }
function Repair-Index([string]$text) { return $text }
function Repair-Login([string]$text) { return $text }

foreach ($name in $files) {
  $path = Join-Path $public $name
  $text = Repair-CommonMarkup (Reverse-Mojibake ([IO.File]::ReadAllText($path, $utf8)))
  switch ($name) {
    'workspace.html' { $text = Repair-Workspace $text }
    'admin.html' { $text = Repair-Admin $text }
    'index.html' { $text = Repair-Index $text }
    'login.html' { $text = Repair-Login $text }
  }
  $out = Join-Path $artifacts ($name -replace '\.html$', '.repaired.html')
  [IO.File]::WriteAllText($out, $text, $utf8)
  $qm = ([regex]::Matches($text, '\?')).Count
  $rg = ([regex]::Matches($text, [char]0xFFFD)).Count
  Write-Output ("{0}: {1} chars, replacement glyphs={2}, question marks={3}" -f $name, $text.Length, $rg, $qm)
}
