# Agent updates

Open **Settings → Machines** to see each connected device's HAPI runner version and installed agent versions. Version checks run on that device. Select **Check for updates**, then **Update** beside an agent, or **Update all** for that device.

The runner downloads each update into a separate directory and checks that the installed CLI reports the expected version before activating it. New HAPI sessions use the new version. Existing sessions keep their selected version and continue running; updating does not stop sessions or restart the runner.

If a download, installation, or version check fails, the current version stays selected. Transient installation failures retry automatically up to three attempts. The page shows progress and reports a failure without claiming success. You can retry from the same button.

## Supported installations

One-click updates currently support Codex, Claude Code, Pi, and GitHub Copilot on macOS and Linux when npm is available. Only installed tools are updated. Tools configured with an explicit executable override remain under your control and show a manual-update notice. Windows, OpenCode, Grok Build, Kimi, Antigravity, and DSH report versions where their executable can be inspected, with manual updates required. Cursor shows a manual version notice instead of launching a probe that could disturb an active session.

An older HAPI runner must first be upgraded using its existing installation method to enable the remote update RPC. The device page displays this requirement. Updating agent tools does not update the HAPI hub or runner itself.

For this personal fork, [internal release binaries](./internal-releases.md) let devices update without downloading or compiling the source.

Managed versions live under `$HAPI_HOME/agent-tools` (default `~/.hapi/agent-tools`). Existing system installations, login data, and agent settings stay in place. Older managed versions are retained for running sessions; automatic cleanup is deliberately deferred.

Agent CLI versions and model access are separate: updating a CLI can expose newly supported models, but the available models also depend on your account and provider.

Implementation checks and the real browser/install trial are recorded in [Agent update validation](../validation/agent-updates.md).
