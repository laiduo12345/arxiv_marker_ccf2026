# Build a reproducible Zotero XPI. The manifest is at the archive root; only runtime files
# are included. Entry order, timestamps, paths, and compression are normalized.
# Run from the repository root: powershell -ExecutionPolicy Bypass -File tools/build-xpi.ps1
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pluginDir = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $pluginDir "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$buildDir = Join-Path $pluginDir "build"
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }
$xpi = Join-Path $buildDir "arxiv_marker_ccf2026-$version.xpi"
if (Test-Path $xpi) { Remove-Item $xpi -Force }

$files = @()
foreach ($f in @("manifest.json", "bootstrap.js", "prefs.js")) {
  $p = Join-Path $pluginDir $f
  if (Test-Path $p) { $files += [PSCustomObject]@{ Path = $p; Entry = $f } }
}
$contentDir = Join-Path $pluginDir "content"
Get-ChildItem $contentDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($pluginDir.Length + 1) -replace '\\', '/'
  $files += [PSCustomObject]@{ Path = $_.FullName; Entry = $rel }
}
$files = $files | Sort-Object Entry

$fixedTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$fileStream = [System.IO.File]::Open($xpi, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive(
  $fileStream,
  [System.IO.Compression.ZipArchiveMode]::Create,
  $false
)
try {
  foreach ($item in $files) {
    $entry = $zip.CreateEntry($item.Entry, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTime
    $input = [System.IO.File]::OpenRead($item.Path)
    $output = $entry.Open()
    try { $input.CopyTo($output) }
    finally {
      $output.Dispose()
      $input.Dispose()
    }
  }
} finally {
  $zip.Dispose()
  $fileStream.Dispose()
}

Write-Output "built: $xpi"
Write-Output "entries:"
$z = [System.IO.Compression.ZipFile]::OpenRead($xpi)
try { $z.Entries | ForEach-Object { Write-Output ("  " + $_.FullName) } }
finally { $z.Dispose() }
