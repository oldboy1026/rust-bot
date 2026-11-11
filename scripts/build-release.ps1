param([string]$OutputDirectory, [string]$ReleaseDate = (Get-Date -Format 'yyyyMMdd'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (!$OutputDirectory) { $OutputDirectory = Split-Path -Parent $projectRoot }
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$projectVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($ReleaseDate -notmatch '^\d{8}$' -or $projectVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release identifier.' }
$archivePath = Join-Path $outputRoot "adminlogger-controller-$projectVersion-public-$ReleaseDate.zip"
if (Test-Path -LiteralPath $archivePath) { throw 'Release archive already exists; choose a different output directory.' }
$rootFiles = @('package.json','package-lock.json','README.md','PUBLIC-DEPLOY.md','LICENSE','NOTICE','.gitignore','.gitattributes','start.cmd','start-network.cmd','open-dashboard.cmd','facepunch-status.cmd','facepunch-log-audit.cmd','facepunch-import-world.cmd','start.sh','start-public.sh')
$sourceFolders = @('src','public','plugin','scripts','test','docs','deploy')
$relativeFiles = [System.Collections.Generic.List[string]]::new()
foreach ($file in $rootFiles) {
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) { throw "Required file missing: $file" }
    $relativeFiles.Add($file)
}
foreach ($folder in $sourceFolders) {
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File -Recurse) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to package a file link.' }
        $resolvedFile = [System.IO.Path]::GetFullPath($item.FullName)
        if (!$resolvedFile.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'File escaped project root.' }
        $relative = $resolvedFile.Substring($projectRoot.Length + 1).Replace('\','/')
        if ($relative -match '(^|/)(data|node_modules|\.git|coverage)(/|$)' -or $relative -match '\.(log|enc|dpapi)$' -or $relative -match '(^|/)\.env$') { throw 'Private or generated file encountered in release sources.' }
        $relativeFiles.Add($relative)
    }
}
$orderedFiles = @($relativeFiles | Sort-Object -Unique)
$manifestLines = [System.Collections.Generic.List[string]]::new()
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($relative in $orderedFiles) {
        $source = Join-Path $projectRoot $relative
        $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifestLines.Add("$hash  $relative")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, "adminlogger-controller/$relative", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    $manifest = $archive.CreateEntry('adminlogger-controller/SHA256SUMS.txt')
    $writer = [System.IO.StreamWriter]::new($manifest.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($manifestLines -join "`n") + "`n") } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashPath = $archivePath + '.sha256'
[System.IO.File]::WriteAllText($hashPath, "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n", [System.Text.UTF8Encoding]::new($false))
[PSCustomObject]@{Archive=$archivePath;Files=$orderedFiles.Count + 1;Bytes=(Get-Item -LiteralPath $archivePath).Length;SHA256=$archiveHash}
