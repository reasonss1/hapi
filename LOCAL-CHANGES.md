# Local integration of upstream v0.36.5

This source combines upstream tag `v0.36.5` (`590a9533c`) with the local
management baseline `3a5eda58d9992af30f2651043cf31abcccde0e7f` and the frozen
MCP/Skill deployment patch from 2026-11-20. The complete patch SHA-256 is
`8ec287a9395b916f01e8a39d9d744b4170b6f47b8217e50e8abba25671379540`.
The plugin handoff identifies its originating PR as
`reasonss1/hapi-plugins#1` (`bfd169b8aa09f7c4c45cb3833d349ad251e566ea`);
the integration uses the complete frozen files, including deployment fixes.

Local behavior retained:

- Historical/offline device management and scoped, confirmed device cleanup.
- Agent version inspection, isolated managed updates and managed launches.
- Translated confirmation controls and stable answer wire values.
- Opt-in MCP configuration and Skill installation through authenticated,
  namespace-scoped Hub-to-Runner RPC, including Codex and Claude injection.
- Codex model catalog loading and cache invalidation. The machine's external
  API synchronization timer and Codex configuration remain separate from this
  source release and must be preserved during executable upgrades.
- A deployment-provided corresponding-source link at `/hapi-local-source.tar.gz`.

Integration fixes:

- Preserve both local management/plugin exports and upstream Passkey/branch APIs.
- Deduplicate the equivalent upstream and local Passkey initialization fix.
- Prevent conversation branches from bypassing device cleanup locks, including
  after asynchronous model discovery; cover both races with regression tests.
- Keep the process-wide Hub test configuration directory alive until process
  exit so later test files can use the shared singleton.

## Build

Use Bun 1.4.4 with the checked-in lockfile. The distributed source bundle also
includes the Linux x64 tunwg build input and its license. Other targets can use
`bun run download:tunwg` before compiling.

```sh
bun install --frozen-lockfile --ignore-scripts
bun typecheck
bun run test
bun run gen:fixtures
bun run build:web
bun run --cwd hub generate:embedded-web-assets
bun run --cwd cli scripts/build-executable.ts --with-web-assets --target bun-linux-x64-baseline
```

The output is `cli/dist-exe/bun-linux-x64-baseline/hapi`. The deployment manifest
records the full integrated source commit, binary hash and source archive hash.
Generated web assets, dependency trees, deployment credentials, databases and
conversation content are not source inputs and are excluded from the archive.

The selected upstream stable release retains database schema 36, already used
by the local management/plugin deployment. Rollback must use the previous
schema-36-compatible executable. Do not restore an old live database snapshot
as part of an executable rollback.
