$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path $PSScriptRoot -Parent
$archivePath = Join-Path $workspaceRoot 'apps\desktop\build\cache\postgresql-18.6-windows-x64.zip'
$outputRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'apps\desktop\build\postgres-unpack'))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name -notmatch '^pgsql/(bin|lib|share)/' -and $name -notmatch '^pgsql/[^/]*(license|notice|copying)[^/]*$') { continue }
        $target = [IO.Path]::GetFullPath((Join-Path $outputRoot $name))
        if (-not $target.StartsWith($outputRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive entry' }
        if ($name.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
} finally { $archive.Dispose() }
