/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { withSessionJobInstruction } from '@/modules/common/sessionJobInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    ${isPeerToolsDisabled() ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
        pingTool: 'functions.hapi__ping_peer',
        listPeersTool: 'functions.hapi__list_peers',
        spawnTool: 'functions.hapi__spawn_peer',
    })}
`);

/** Device plugins are deferred tools in Codex code mode, including child agents. */
export const MCP_DISCOVERY_INSTRUCTION = trimIdent(`
    HAPI's Hub To Do bridge and enabled device MCP plugins are inherited by child agents. When functions.exec is available, discover deferred tools through ALL_TOOLS inside functions.exec before reporting a plugin missing. For Microsoft To Do, search tool names and descriptions for "todo" and prefer the hapi-todo Hub bridge when available, then call the matching method on tools using the exact discovered name and schema. The initial tool list and list_mcp_resources do not enumerate all callable MCP tools. If discovery or a call fails, report the specific failure; an approval denial is different from a missing tool.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 * Session-summary contract is resolved at call time (hub toggle / env).
 */
export function getCodexSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(withSessionJobInstruction(`${TITLE_INSTRUCTION}\n\n${MCP_DISCOVERY_INSTRUCTION}`), env)
}

/** Alias kept for existing call sites / tests that expect a string constant name. */
export const codexSystemPrompt = TITLE_INSTRUCTION
