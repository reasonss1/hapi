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

Every release must have a strictly newer numeric HAPI version, including installer hotfixes and releases that change only the Hub or Runner. Increment the patch version for fixes. The first version after the legacy `0.36.5` builds can be `0.36.6`.

From the repository root, use the existing version helper, refresh the lockfile, then validate against the versions running on the deployment targets. For example, to release `0.36.6` when the latest deployed version is `0.36.5`:

```sh
bun -e 'import { updateReleaseVersions } from "./cli/scripts/release-version.ts"; updateReleaseVersions(process.cwd(), "0.36.6")'
bun install --lockfile-only
bun scripts/check-internal-release-version.mjs internal-v0.36.6 0.36.5
```

Commit the code and version changes together. Push the tested commit and an immutable `internal-v<version>` tag to the personal fork. CI requires the tag, CLI version and shared version to agree, and the version to be newer than earlier internal tags. It builds and smoke-tests the Linux x64 executable, packages it with the commit and hashes, and publishes a prerelease in the same fork. For manual Hub or Runner deployments, run the same version check before building and package the exact Git commit that passed it.

Activate the build on the Hub and each target Runner using the release manifest for that commit. Compare the reported version and executable hash after each activation. If an already published release needs a fix, increment the version again and create a new tag.
