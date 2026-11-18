#Requires -Version 5.1
# Offline smoke checks with real ZIP/hash I/O and the actual compiled executable.
# Run in Windows PowerShell 5.1 or PowerShell 7; no Pester or network is needed.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $BinaryPath)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$downloader = Join-Path $PSScriptRoot 'download-internal.ps1'
$tag = 'internal-downloader-smoke'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hapi-download-test-' + [Guid]::NewGuid().ToString('N'))
$downloadState = @{ FixtureDirectory = (Join-Path $testRoot 'fixtures'); Count = 0 }
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

# The downloader resolves this parent-scope function instead of the network
# cmdlet. Keep every production URL and downloaded byte unchanged.
function Invoke-WebRequest {
    [CmdletBinding()]
    param([switch] $UseBasicParsing, [string] $Uri, [string] $OutFile, [int] $TimeoutSec, [int] $MaximumRedirection)
    $name = [IO.Path]::GetFileName(([Uri] $Uri).AbsolutePath)
    $expected = "https://github.com/reasonss1/hapi/releases/download/$tag/$name"
    Assert-True ($Uri -ceq $expected) "Unexpected release URL: $Uri"
    Assert-True ($name -cin @('checksums.txt', 'release-manifest.json', 'hapi-win32-x64.zip')) 'Unexpected asset download.'
    Assert-True $UseBasicParsing.IsPresent 'Downloads must use basic parsing on Windows PowerShell.'
    $downloadState.Count++
    Copy-Item -LiteralPath (Join-Path $downloadState.FixtureDirectory $name) -Destination $OutFile
}

function Write-Zip([string] $Path, [string] $EntryName, [bool] $UseBinary) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        $entry = $zip.CreateEntry($EntryName, [IO.Compression.CompressionLevel]::Optimal)
        $output = $entry.Open()
        try {
            if ($UseBinary) {
                $inputStream = [IO.File]::OpenRead($binary)
                try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose() }
            } else {
                $bytes = [Text.Encoding]::ASCII.GetBytes('This entry must never be extracted.')
                $output.Write($bytes, 0, $bytes.Length)
            }
        } finally { $output.Dispose() }
    } finally { $zip.Dispose(); $stream.Dispose() }
}

function Set-Fixture([string] $Case = 'valid') {
    $archivePath = Join-Path $downloadState.FixtureDirectory 'hapi-win32-x64.zip'
    Copy-Item -LiteralPath (Join-Path $testRoot 'valid.zip') -Destination $archivePath -Force
    if ($Case -eq 'traversal') { Write-Zip $archivePath '../escape.exe' $false }
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Case -eq 'archive-checksum') { $archiveHash = 'a' * 64 }
    $manifest = @{
        schemaVersion = 1
        repository = 'reasonss1/hapi'
        tag = $tag
        commit = ('a' * 40)
        cliVersion = $cliVersion
        artifacts = @(@{
            platform = 'win32'; arch = 'x64'; file = 'hapi-win32-x64.zip'
            binary = 'hapi.exe'; sha256 = $archiveHash
        })
    }
    switch ($Case) {
        'repository' { $manifest.repository = 'tiann/hapi' }
        'tag' { $manifest.tag = 'internal-another-source' }
        'commit' { $manifest.commit = 'short-sha' }
        'artifact' { $manifest.artifacts[0].binary = '../hapi.exe' }
        'duplicate-artifact' { $manifest.artifacts = @($manifest.artifacts[0], $manifest.artifacts[0]) }
    }
    $manifestPath = Join-Path $downloadState.FixtureDirectory 'release-manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", $utf8)
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Case -eq 'manifest-checksum') { $manifestHash = 'b' * 64 }
    $checksums = "$archiveHash  hapi-win32-x64.zip`n$manifestHash  release-manifest.json`n"
    [IO.File]::WriteAllText((Join-Path $downloadState.FixtureDirectory 'checksums.txt'), $checksums, $utf8)
}

function Test-Rejection([string] $Case, [string] $ErrorPattern) {
    Set-Fixture $Case
    $root = Join-Path $testRoot $Case
    $oldDirectory = Join-Path $root 'internal-previous'
    [void] [IO.Directory]::CreateDirectory($oldDirectory)
    $oldBinary = Join-Path $oldDirectory 'hapi.exe'
    [IO.File]::WriteAllText($oldBinary, 'old installation must survive', $utf8)
    $oldHash = (Get-FileHash -LiteralPath $oldBinary -Algorithm SHA256).Hash
    $failure = $null
    try { & $downloader -Tag $tag -DownloadDirectory $root } catch { $failure = $_.Exception.Message }
    Assert-True ($null -ne $failure -and $failure -match $ErrorPattern) "Expected $Case rejection, got: $failure"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root $tag))) "Failed $Case download published a tag directory."
    Assert-True (((Get-FileHash -LiteralPath $oldBinary -Algorithm SHA256).Hash) -ceq $oldHash) "Failed $Case download changed the old binary."
    $leftovers = @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -like '.download-*' })
    Assert-True ($leftovers.Count -eq 0) "Failed $Case download left a staging directory or owned lock."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'escape.exe'))) 'ZIP traversal wrote outside staging.'
    Write-Host "PASS: $Case rejection preserves old files and cleans staging."
}

try {
    [void] [IO.Directory]::CreateDirectory($downloadState.FixtureDirectory)
    $version = ((& $binary --version) -join "`n").Trim()
    Assert-True ($LASTEXITCODE -eq 0 -and $version -cmatch '\Ahapi version: (\S+)\z') 'Expected a real compiled HAPI executable.'
    $cliVersion = $Matches[1]
    Write-Zip (Join-Path $testRoot 'valid.zip') 'hapi.exe' $true
    Set-Fixture
    # Spaces exercise literal paths, ZIP output and native executable launch.
    $successRoot = Join-Path $testRoot 'successful download with spaces'
    & $downloader -Tag $tag -DownloadDirectory $successRoot
    $stagedBinary = Join-Path (Join-Path $successRoot $tag) 'hapi.exe'
    Assert-True (Test-Path -LiteralPath $stagedBinary) 'Successful download did not stage hapi.exe.'
    Assert-True (((Get-FileHash -LiteralPath $stagedBinary -Algorithm SHA256).Hash) -ceq ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash)) 'Staged binary differs from the real build.'
    Write-Host 'PASS: real executable download, checksums, manifest, version and help.'

    $beforeDuplicate = $downloadState.Count
    $failure = $null
    try { & $downloader -Tag $tag -DownloadDirectory $successRoot } catch { $failure = $_.Exception.Message }
    Assert-True ($null -ne $failure -and $failure -match 'Already downloaded') 'Duplicate target was not rejected.'
    Assert-True ($downloadState.Count -eq $beforeDuplicate) 'Duplicate target attempted to download or replace files.'
    Assert-True (((Get-FileHash -LiteralPath $stagedBinary -Algorithm SHA256).Hash) -ceq ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash)) 'Duplicate target changed the existing binary.'
    Write-Host 'PASS: an existing release is never overwritten.'

    Test-Rejection 'archive-checksum' 'Archive checksum mismatch'
    Test-Rejection 'manifest-checksum' 'Manifest checksum mismatch'
    Test-Rejection 'traversal' 'ZIP containing only'
    Test-Rejection 'repository' 'schema, repository or tag'
    Test-Rejection 'tag' 'schema, repository or tag'
    Test-Rejection 'commit' 'full source commit'
    Test-Rejection 'artifact' 'artifact fields'
    Test-Rejection 'duplicate-artifact' 'exactly one Windows x64'

    $lockedRoot = Join-Path $testRoot 'concurrent'
    [void] [IO.Directory]::CreateDirectory($lockedRoot)
    $lockPath = Join-Path $lockedRoot ".download-$tag.lock"
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $failure = $null
        try { & $downloader -Tag $tag -DownloadDirectory $lockedRoot } catch { $failure = $_.Exception.Message }
        Assert-True ($null -ne $failure -and $failure -match 'Cannot acquire') 'Concurrent download lock was ignored.'
        Assert-True ([IO.File]::Exists($lockPath)) 'A competing download removed another owner lock.'
    } finally { $lock.Dispose() }
    Write-Host 'PASS: concurrent owner lock is respected and retained.'
    Write-Host 'All Windows internal downloader smoke checks passed.'
} finally {
    if ([IO.Directory]::Exists($testRoot)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
