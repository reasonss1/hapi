#Requires -Version 5.1
<#
.SYNOPSIS
Downloads and validates a Windows x64 internal HAPI build without activating it.
.PARAMETER Tag
An immutable internal-* release tag in reasonss1/hapi.
.PARAMETER DownloadDirectory
Parent directory for staged releases. Defaults to HAPI_HOME/internal-releases,
or ~/.hapi/internal-releases when HAPI_HOME is unset.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Tag,
    [string] $DownloadDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($Tag -cnotmatch '\Ainternal-[A-Za-z0-9][A-Za-z0-9._-]*\z' -or $Tag.EndsWith('.')) {
    throw 'Expected an internal-* tag without path separators or a trailing dot.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This downloader supports Windows x64 only.'
}
$nativeArchitecture = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrEmpty($nativeArchitecture)) {
    $nativeArchitecture = $env:PROCESSOR_ARCHITECTURE
}
if (-not [Environment]::Is64BitOperatingSystem -or $nativeArchitecture -ine 'AMD64') {
    throw 'This release requires Windows x64.'
}

function Get-ReleaseHash([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Checksum([string] $ChecksumsPath, [string] $FileName) {
    $found = @()
    foreach ($line in [IO.File]::ReadAllLines($ChecksumsPath)) {
        if ($line -cmatch '\A([0-9a-fA-F]{64})[ \t]+\*?([^/\\\r\n]+)\z') {
            if ($Matches[2] -ceq $FileName) {
                $found += $Matches[1].ToLowerInvariant()
            }
        }
    }
    if ($found.Count -ne 1) {
        throw "Missing or ambiguous SHA-256 checksum for $FileName."
    }
    return $found[0]
}

function Save-ReleaseAsset([string] $Name, [string] $Directory) {
    $url = "https://github.com/reasonss1/hapi/releases/download/$Tag/$Name"
    $output = Join-Path $Directory $Name
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            # A caller can mock this command for offline smoke tests. Production
            # downloads always use the fixed HTTPS personal-fork release URL.
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $output -TimeoutSec 600 -MaximumRedirection 5 -ErrorAction Stop | Out-Null
            return
        } catch {
            if ($attempt -eq 3) { throw "Could not download $Name. $($_.Exception.Message)" }
            Start-Sleep -Seconds 2
        }
    }
}

function Invoke-BinaryProbe([string] $Executable, [string] $Argument, [string] $Directory) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Argument
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw "Could not start staged hapi.exe $Argument." }
        $process.StandardInput.Close()
        # Drain both pipes concurrently; a full stderr pipe must not hang a
        # version/help probe. Bound the process and pipe completion separately.
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            throw "Staged hapi.exe $Argument timed out."
        }
        $reads = [System.Threading.Tasks.Task[]] @($stdout, $stderr)
        if (-not [System.Threading.Tasks.Task]::WaitAll($reads, 5000)) {
            throw "Staged hapi.exe $Argument did not close its output pipes."
        }
        if ($process.ExitCode -ne 0) {
            throw "Staged hapi.exe $Argument failed with exit code $($process.ExitCode)."
        }
        return $stdout.GetAwaiter().GetResult()
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            [void] $process.WaitForExit(5000)
        }
        $process.Dispose()
    }
}

if ([string]::IsNullOrEmpty($DownloadDirectory)) {
    $homeDirectory = $env:HAPI_HOME
    if ([string]::IsNullOrEmpty($homeDirectory)) {
        $homeDirectory = Join-Path $HOME '.hapi'
    }
    $DownloadDirectory = Join-Path $homeDirectory 'internal-releases'
}
$root = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DownloadDirectory)
$root = [IO.Path]::GetFullPath($root)
$destination = Join-Path $root $Tag
$lockPath = Join-Path $root ".download-$Tag.lock"
$stage = $null
$lock = $null
$previousTls = [Net.ServicePointManager]::SecurityProtocol
$previousProgress = $ProgressPreference

try {
    [void] [IO.Directory]::CreateDirectory($root)
    try {
        # CreateNew refuses both a concurrent owner and a leftover lock. Never
        # remove a lock we did not acquire or guess another process is dead.
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw "Cannot acquire $lockPath. Another download or a leftover lock exists; current files were left unchanged."
    }
    if (Test-Path -LiteralPath $destination) {
        throw "Already downloaded: $destination (left unchanged)."
    }
    $stage = Join-Path $root ('.download-' + [Guid]::NewGuid().ToString('N'))
    [void] [IO.Directory]::CreateDirectory($stage)
    [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'

    Write-Host "Downloading $Tag for Windows x64..."
    Save-ReleaseAsset 'checksums.txt' $stage
    Save-ReleaseAsset 'release-manifest.json' $stage
    $checksumsPath = Join-Path $stage 'checksums.txt'
    $manifestPath = Join-Path $stage 'release-manifest.json'
    $manifestHash = Get-Checksum $checksumsPath 'release-manifest.json'
    if ((Get-ReleaseHash $manifestPath) -cne $manifestHash) {
        throw 'Manifest checksum mismatch; current HAPI was not changed.'
    }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -ErrorAction Stop
    if ($manifest.schemaVersion -ne 1 -or $manifest.repository -cne 'reasonss1/hapi' -or $manifest.tag -cne $Tag) {
        throw 'The manifest schema, repository or tag does not match this release.'
    }
    if ($manifest.commit -isnot [string] -or $manifest.commit -cnotmatch '\A[0-9a-f]{40}\z') {
        throw 'The manifest must identify a full source commit SHA.'
    }
    if ($manifest.cliVersion -isnot [string] -or $manifest.cliVersion -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\z') {
        throw 'The manifest CLI version is invalid.'
    }
    if ($manifest.artifacts -isnot [Array]) {
        throw 'The manifest must contain an artifacts array.'
    }
    $artifacts = @($manifest.artifacts | Where-Object { $_.platform -ceq 'win32' -and $_.arch -ceq 'x64' })
    if ($artifacts.Count -ne 1) {
        throw 'Expected exactly one Windows x64 artifact in the manifest.'
    }
    $artifact = $artifacts[0]
    if ($artifact.file -cne 'hapi-win32-x64.zip' -or $artifact.binary -cne 'hapi.exe' -or
        $artifact.sha256 -isnot [string] -or $artifact.sha256 -cnotmatch '\A[0-9a-f]{64}\z') {
        throw 'The Windows x64 artifact fields are invalid.'
    }
    $archiveHash = Get-Checksum $checksumsPath 'hapi-win32-x64.zip'
    if ($artifact.sha256 -cne $archiveHash) {
        throw 'The manifest and checksum list disagree about the Windows archive.'
    }
    Save-ReleaseAsset 'hapi-win32-x64.zip' $stage
    $archivePath = Join-Path $stage 'hapi-win32-x64.zip'
    if ((Get-ReleaseHash $archivePath) -cne $archiveHash) {
        throw 'Archive checksum mismatch; current HAPI was not changed.'
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.Count -ne 1 -or $archive.Entries[0].FullName -cne 'hapi.exe' -or $archive.Entries[0].Length -le 0) {
            throw 'Expected a ZIP containing only the regular file hapi.exe.'
        }
        $entry = $archive.Entries[0]
        $attributes = [int64] $entry.ExternalAttributes -band [int64] 4294967295
        $unixType = ($attributes -shr 16) -band 61440
        if (($unixType -ne 0 -and $unixType -ne 32768) -or ($attributes -band 1040) -ne 0) {
            throw 'The archive entry must be a regular file, not a directory or link.'
        }
        # Write to our own fixed path instead of extracting any archive paths.
        $binaryPath = Join-Path $stage 'hapi.exe'
        $inputStream = $entry.Open()
        try {
            $outputStream = [IO.File]::Open($binaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    } finally { $archive.Dispose() }

    $version = (Invoke-BinaryProbe $binaryPath '--version' $root).Trim()
    if ($version -cne ('hapi version: ' + $manifest.cliVersion)) {
        throw 'The executable version does not match the release manifest.'
    }
    $help = Invoke-BinaryProbe $binaryPath '--help' $root
    if (-not $help.Contains('HAPI - Coding agents with remote control') -or $help -notmatch '(?m)^Usage:') {
        throw 'The staged executable did not return the expected HAPI help.'
    }
    Remove-Item -LiteralPath $archivePath -Force
    # Directory.Move is a same-volume rename and refuses an existing target;
    # unlike Move-Item, it cannot nest a staging directory inside an old tag.
    # Windows scanners or recently exited executables can hold the directory
    # briefly. Retry the rename without deleting or replacing any destination.
    $moved = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            [IO.Directory]::Move($stage, $destination)
            $moved = $true
            break
        } catch {
            if (Test-Path -LiteralPath $destination) { throw }
            $cause = $_.Exception
            while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
            if (($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException]) -or $attempt -eq 20) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $moved) { throw 'Could not finalize the verified download; current HAPI was not changed.' }
    $stage = $null
    Write-Host "Verified binary: $(Join-Path $destination 'hapi.exe')"
    Write-Host "Source commit: $($manifest.commit)"
    Write-Host 'Download complete. The current installation, services and running sessions have not been changed.'
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousTls
    $ProgressPreference = $previousProgress
    try {
        if ($null -ne $stage -and [IO.Directory]::Exists($stage)) {
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
    } finally {
        if ($null -ne $lock) {
            $lock.Dispose()
            Remove-Item -LiteralPath $lockPath -Force
        }
    }
}
