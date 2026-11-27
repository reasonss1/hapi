# Plugins: MCP and Skills

Open **Settings → Plugins** to configure a connected Runner. The first version supports Codex and Claude Code. Pick the device and the agent type before making changes. Start a new agent session to use the updated configuration.

## Enable management on a trusted Runner

Start the Runner with `HAPI_ENABLE_PLUGIN_MANAGEMENT=1`. Only enable this on a Runner you administer, attached to a namespace whose users can be trusted to run code under the Runner's OS account: a local MCP command is executable software, and a Skill can tell the agent to run scripts. Keep separate OS accounts or containers for parties that must not share native agent configuration and Skills. If a supervisor manages your Runner, add the variable to its environment and restart it through that supervisor.

```sh
HAPI_ENABLE_PLUGIN_MANAGEMENT=1 hapi runner start
```

For PowerShell:

```powershell
$env:HAPI_ENABLE_PLUGIN_MANAGEMENT = '1'
hapi runner start
```

This mode applies to sessions started with the same Runner environment. If you start a session from a separate terminal, it must inherit the same opt-in and use the same HAPI home and access credential. Changing the Hub access credential makes the previous MCP registry unavailable to the new credential. To turn off management, restart the Runner without the variable; previously uploaded native Skills remain installed.

## Connect an MCP service

- **HTTP endpoint**: enter the Streamable HTTP URL, for example `https://mcp.example.com/mcp`. Use HTTPS for a remote service. Local development supports e.g. `http://127.0.0.1:3000/mcp`; loopback refers to the selected Runner. Set up accounts according to the service and agent's authentication flow. HAPI's form does not collect credentials or custom headers; if the server needs these features, use the agent's own MCP configuration or an authorized connector on the Runner. URLs with embedded credentials or query parameters are rejected.
- **Local command (stdio)**: enter the executable on the selected Runner and provide each argument on a separate line. The command starts under the agent when the session loads tools. Paste only the executable in the program field; the arguments field supplies its argument list. On Windows, use a native executable such as `node.exe` with the package's entry point if a package-manager shim is unavailable to the agent.

Once added, a server is enabled for new sessions. The list shows saved configuration, rather than claiming the server is connected. Ask an agent in a new session to list or call a read-only tool to test it. Disable or remove the entry to omit it from future sessions; close running sessions if access needs to stop immediately. HAPI-managed tool server names begin with `hapi-plugin-`. Other servers configured directly in the agent remain in the agent's native settings.

Codex waits for enabled HAPI device MCP plugins to initialize before starting a parent or child agent turn. Discovery waits up to each server’s startup timeout. If a plugin cannot start, check its startup error, repair or disable it in Settings → Plugins, and start a new session. This prevents a child agent's first turn from silently missing tools from a slow-starting service. In Codex code mode, agents discover deferred MCP tools through `ALL_TOOLS` inside `functions.exec`; the initial tool list and MCP resource list are not a complete tool inventory. Normal tool approval rules still apply.

### Microsoft To Do and multiple topics

#### Share the Hub's To Do connection across devices

When the Hub has `HAPI_TODO_MCP_COMMAND` and `HAPI_TODO_NAMESPACE` configured for its To Do page, HAPI also offers that connector to agents in the same namespace. New Codex and Claude Code sessions on connected devices automatically receive the `hapi-todo` MCP server, including their child agents. Both the Hub and the device CLI must run a version with this bridge. Existing sessions need to be restarted to load it.

The device runs the built-in `hapi todo-mcp` stdio proxy. It forwards tool discovery and calls through the authenticated Hub connection; the provider executable, Microsoft login, and Microsoft token cache stay on the Hub. No separate MCP port or Microsoft installation is needed on the device, and local plugin-management opt-in is not required. Other MCP clients can explicitly configure `hapi todo-mcp` as a stdio command using that device's existing HAPI connection settings.

The bridge exposes three read-only tools: list task lists, list tasks, and get a task. Devices in other namespaces cannot discover or call the connector. Task changes still use the To Do page or a separately configured MCP server with write access.

If the Hub is unavailable or has no connector for the device's namespace, no Hub server is injected into new sessions. Local MCP entries continue to load independently. A connection lost during a call is reported as a tool error. For the Hub connection, check `HAPI_API_URL`, the device's HAPI credential, and its namespace; copying the Hub's local MCP executable path into a remote device's plugin settings will not work.

#### Connect a separate MCP service

Microsoft To Do can be connected through an existing MCP service, such as [jordanburke/microsoft-todo-mcp-server](https://github.com/jordanburke/microsoft-todo-mcp-server). The service operator sets up the server and its Microsoft authentication. Before adding the endpoint to HAPI, verify that your client supports the server's authentication and that each user is authorized for the intended To Do account.

The same HTTP service can be connected on several Runner/agent pairs. Each new session, including a topic using that Runner and agent type, receives the configured tools. Separate HAPI topics don't automatically map to separate Microsoft accounts or task lists. A topic that must not get the tools should use a separate Runner/agent configuration without the connection. Native client configuration can also supply tools independently of this page.

If multiple agents use the same To Do account, they can work from the same list. For a first trial, have one dispatcher assign tasks and handle writes, and have other agents read and report back. Server-side read-only credentials or tool restrictions are needed if you want to enforce that division. MCP tool access alone does not implement ownership, prevent duplicate claims, or record human acceptance.

## Install a Skill

Upload a `SKILL.md` file, or select a folder with `SKILL.md` at its root to keep companion files. The manifest must contain a `name` and a `description`. The installer preserves folders and file contents, refuses to overwrite an existing skill directory, and accepts up to 100 files totaling 2 MiB. Read the Skill and its scripts before installing it. Browser uploads do not retain executable permission bits; invoke companion scripts through their interpreter where needed.

For Codex the destination is the user's `.agents/skills` directory; for Claude Code it's the `skills` directory under its user configuration (`CLAUDE_CONFIG_DIR`, default `~/.claude`). These are native, device user settings, so a Skill can also be discovered by sessions of that user outside HAPI. The page lists user-visible skills; project-specific skills depend on the session directory. To remove a Skill, remove its installed directory on the device.
