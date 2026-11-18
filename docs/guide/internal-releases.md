# Windows internal releases

Windows x64 devices can download a compiled binary from an **internal prerelease** in [reasonss1/hapi](https://github.com/reasonss1/hapi/releases). They do not need Git, Bun, npm, or a source checkout. The binary includes the CLI, Runner, Hub, and web assets. Other platforms are deferred. Windows agent-tool installations still require manual updates in this branch; these packages simplify deploying HAPI CLI/Runner itself.

Choose the same release tag on every device. Download `hapi-win32-x64.zip`, or use the release's `download-internal.ps1` helper. Check `release-manifest.json` for the full source commit and `checksums.txt` for SHA-256 hashes; the CLI version alone may match an upstream version.

In PowerShell, substitute the selected tag for `TAG`:

```powershell
$tag = 'TAG'
$script = Join-Path $env:TEMP "hapi-download-$([guid]::NewGuid()).ps1"
try {
    Invoke-WebRequest -UseBasicParsing "https://github.com/reasonss1/hapi/releases/download/$tag/download-internal.ps1" -OutFile $script
    & $script -Tag $tag
} finally {
    Remove-Item -LiteralPath $script -ErrorAction SilentlyContinue
}
```

The helper verifies the ZIP and manifest, checks the extracted executable, then puts the files under `$env:HAPI_HOME/internal-releases/TAG` (default `~/.hapi/internal-releases/TAG`). It does not replace the installation or restart any process. If local policy prevents running the script, the device's agent can download and verify the ZIP directly.

Ask the device's agent to activate the verified binary using its existing installation and supervision method. Preserve the old executable, Hub URL, credentials, HAPI home, and workspace arguments. Confirm that changing or restarting the Runner will not terminate existing sessions through the supervisor's process-group policy. When a safe handoff is unavailable, finish staging and report what prevents activation. The Hub host also needs its Hub/web process switched to the new binary; other devices only need their CLI/Runner switched.

After activation, verify that the device is online, advertises `agent-tool-updates`, and can inspect agent versions. Existing sessions keep their running code; they are not upgraded in place.

## Build a new internal release

Push the tested source commit to the personal fork, then push an `internal-*` tag pointing to that commit. `.github/workflows/internal-release.yml` builds and smoke-tests the Windows executable, packages it with hashes and source metadata, and publishes a prerelease in the same fork. The workflow does not publish npm packages or update Homebrew. Keep tags immutable; use a new tag for each source revision.
