import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VaultToolDefinition } from '../tools/vaultTools';

export const MCP_SERVER_NAME = 'obsidian-private-ai';

export interface VaultMcpServerOptions {
	version: string;
	/** Read on every request, so toggling the setting takes effect immediately. */
	allowWrites: () => boolean;
}

/**
 * The plugin's built-in MCP server. It is the single place vault tools are
 * published. Only the in-plugin Pi agent connects to it, in-process. It is
 * never exposed outside Obsidian: there is no network transport.
 */
export function createVaultMcpServer(tools: VaultToolDefinition[], options: VaultMcpServerOptions): Server {
	const server = new Server(
		{ name: MCP_SERVER_NAME, title: 'Obsidian Private AI vault', version: options.version },
		{
			capabilities: { tools: { listChanged: false } },
			instructions:
				'Tools for searching, reading and editing the notes in an Obsidian vault. ' +
				'Search (search_notes / grep_notes) before reading, and cite note paths in answers.',
		},
	);

	const visible = (): VaultToolDefinition[] => (options.allowWrites() ? tools : tools.filter((t) => t.readOnly));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: visible().map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.inputSchema,
			annotations: {
				title: t.title,
				readOnlyHint: t.readOnly,
				destructiveHint: !!t.destructive,
				openWorldHint: false,
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const tool = visible().find((t) => t.name === request.params.name);
		if (!tool) {
			const hidden = tools.some((t) => t.name === request.params.name);
			return {
				isError: true,
				content: [{
					type: 'text',
					text: hidden
						? `${request.params.name} is disabled: note changes are turned off in the Private AI settings.`
						: `Unknown tool: ${request.params.name}`,
				}],
			};
		}
		try {
			const text = await tool.run((request.params.arguments ?? {}) as Record<string, unknown>);
			return { content: [{ type: 'text', text }] };
		} catch (error) {
			return { isError: true, content: [{ type: 'text', text: (error as Error)?.message ?? String(error) }] };
		}
	});

	return server;
}
