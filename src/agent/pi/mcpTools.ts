import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TSchema } from 'typebox';

interface McpContentItem {
	type: string;
	text?: string;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return (content as McpContentItem[])
		.map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type} content]`))
		.join('\n');
}

/**
 * Turns every tool on an MCP server into a Pi AgentTool. Pi has no MCP
 * support of its own; this adapter is the bridge, so the agent only ever
 * reaches the vault through the MCP server.
 */
export async function loadMcpTools(client: Client): Promise<AgentTool[]> {
	const { tools } = await client.listTools();
	return tools.map((tool): AgentTool => ({
		name: tool.name,
		label: tool.title ?? tool.annotations?.title ?? tool.name,
		description: tool.description ?? '',
		// MCP input schemas are plain JSON Schema, which Pi validates directly.
		parameters: tool.inputSchema as unknown as TSchema,
		executionMode: tool.annotations?.readOnlyHint ? 'parallel' : 'sequential',
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ mcpTool: string }>> {
			const result = await client.callTool(
				{ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
				undefined,
				{ signal },
			);
			const text = textOf(result.content);
			if (result.isError) throw new Error(text || `${tool.name} failed`);
			return { content: [{ type: 'text', text }], details: { mcpTool: tool.name } };
		},
	}));
}
