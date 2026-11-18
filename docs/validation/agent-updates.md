# Agent update validation

Validated on 2026-11-18 from the `feat/agent-updates` implementation based on HAPI v0.36.0. This branch is for testing in the personal fork before proposing an upstream change.

## Automated checks

All workspace typechecks passed. Complete package suites passed:

| Package | Passing tests |
| --- | ---: |
| CLI | 5,613 |
| Hub | 2,042 |
| Web | 4,594 |
| Shared protocol | 489 |
| Push relay | 118 |
| Total | 12,856 |

The suites retain their existing skipped tests and one expected failure in the web suite. After the final review fixes, the focused service/helper suite passed 25 tests, the focused device update UI suite passed 12 tests, and the CLI typecheck passed again.

Regression coverage includes failed installs retaining the selected version, candidate version mismatch, duplicate requests, serialized installs, low disk space, interrupted updates, namespace isolation, explicit executable overrides, stale status responses, safe Copilot version probes, and unsupported platform handling.

## Real internal trial

The trial used a new loopback Hub, two independent runner instances on one Linux host, isolated home directories and Codex homes, a fresh test credential, and a fresh database. It did not use the production database, production credentials, or agent account credentials. A real Chromium browser opened the device page and clicked **Update** once for Internal-A.

Results:

- Internal-A installed the official npm Codex package and advanced from 0.166.0 to 0.170.0.
- The previous Codex app-server retained its PID and process start marker. It answered 46 configuration RPC requests across the trial, with a maximum measured round trip of 8.74 ms.
- An existing wrapper process retained its original executable selection; a new wrapper process selected the managed 0.170.0 executable.
- The new Codex app-server initialized and answered configuration RPC requests.
- Internal-B stayed on 0.166.0; both runners remained alive.
- The browser sent exactly one update request, showed completion, and retained the result after reload.
- A request from a different test namespace was refused.
- The system Codex executable/version and production Hub/runner PIDs remained unchanged.
- Trial processes and temporary installations were removed after validation.

## Remaining coverage limits

This is a real installation and browser trial with two isolated runner instances on one host, not a test across two physical devices. It did not run an authenticated model turn or verify model entitlement. macOS installation and the other supported agents still need equivalent real-device trials; Windows updates remain manual. Updating agent tools does not upgrade the HAPI runner or Hub. Existing runners require a one-time HAPI update before they can expose this feature.

See [Agent updates](../guide/agent-updates.md) for supported tools and usage.
