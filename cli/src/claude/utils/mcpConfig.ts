import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type McpConfigArg = {
    value: string;
    cleanup?: () => void;
};

export type McpConfigOptions = {
    useFile?: boolean;
    baseDir?: string;
};

export function resolveMcpConfigArg(
    mcpServers: Record<string, unknown>,
    options?: McpConfigOptions
): McpConfigArg {
    const configJson = JSON.stringify({ mcpServers });
    // The Hub bridge carries the device's HAPI credential in its MCP env.
    // Keep that value out of Claude's process arguments on every platform.
    const hubTodo = mcpServers['hapi-todo'] as { env?: { CLI_API_TOKEN?: string } } | undefined;
    const useFile = Boolean(hubTodo?.env?.CLI_API_TOKEN) || (options?.useFile ?? process.platform === 'win32');
    if (!useFile) {
        return { value: configJson };
    }

    const dir = options?.baseDir ?? tmpdir();
    mkdirSync(dir, { recursive: true });

    const filePath = join(
        dir,
        `mcp-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    writeFileSync(filePath, configJson, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    return {
        value: filePath,
        cleanup: () => {
            try {
                unlinkSync(filePath);
            } catch {
                // Ignore cleanup errors; config file is optional and short-lived.
            }
        }
    };
}

export function appendMcpConfigArg(
    args: string[],
    mcpServers?: Record<string, unknown>,
    options?: McpConfigOptions
): (() => void) | null {
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
        return null;
    }

    const { value, cleanup } = resolveMcpConfigArg(mcpServers, options);
    args.push('--mcp-config', value);
    return cleanup ?? null;
}
