# Linux internal releases

Linux x64 devices can download a compiled binary from an **internal prerelease** in [reasonss1/hapi](https://github.com/reasonss1/hapi/releases). They do not need Git, Bun, npm, or a source checkout. The binary includes the CLI, Runner, Hub, and web assets. Other platforms are deferred.

Choose the same release tag on every device. Download `hapi-linux-x64.tar.gz`, or use the release's `download-internal.sh` helper. Check `release-manifest.json` for the full source commit and `checksums.txt` for SHA-256 hashes; the CLI version alone may match an upstream version.

Substitute the selected release tag for `TAG`:

```sh
curl --http1.1 -fsSL https://github.com/reasonss1/hapi/releases/download/TAG/download-internal.sh | sh -s -- TAG
```

The helper downloads the archive, verifies its SHA-256 hash and manifest, and checks the extracted executable. It saves the result under `$HAPI_HOME/internal-releases/TAG` (default `~/.hapi/internal-releases/TAG`). It does not replace the installation or restart any process.

Ask the device's agent to activate the verified binary using its existing installation and supervision method. Preserve the old executable, Hub URL, credentials, HAPI home, and workspace arguments. Confirm that changing or restarting the Runner will not terminate existing sessions through the supervisor's process-group policy. When a safe handoff is unavailable, finish staging and report what prevents activation. The Hub host also needs its Hub/web process switched to the new binary; other devices only need their CLI/Runner switched.

After activation, verify that the device is online, advertises `agent-tool-updates`, and can inspect agent versions. Existing sessions keep their running code; they are not upgraded in place.

## Build a new internal release

Push the tested source commit to the personal fork, then push an `internal-*` tag pointing to that commit. `.github/workflows/internal-release.yml` builds and smoke-tests the Linux x64 executable, packages it with hashes and source metadata, and publishes a prerelease in the same fork. The workflow does not publish npm packages or update Homebrew. Keep tags immutable; use a new tag for each source revision.
