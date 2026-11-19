import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VaultToolDefinition } from '../tools/vaultTools';

export const MCP_SERVER_NAME = 'obsidian-private-ai';

export interface VaultMcpServerOptions {
	version: string;
	/** Read on every request, so toggling the setting takes effect immediately. */
	allowWrites: () => boolean;
	/**
	 * Asks the user whether to turn note changes on, when a write tool is called while they
	 * are off. Resolves true only if they are now on. Without it, write tools are hidden
	 * and refused while changes are off.
	 */
	requestWrites?: (tool: VaultToolDefinition) => Promise<boolean>;
}

export const WRITES_STAY_OFF_MESSAGE =
	'Changing notes is turned off, and the user chose to keep it off, so nothing was changed. Do not retry it unless the user asks again.';

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

	// With a way to ask the user, write tools stay listed while changes are off, so the model
	// can try one and the user gets the question. Otherwise they are hidden.
	const visible = (): VaultToolDefinition[] =>
		options.allowWrites() || options.requestWrites ? tools : tools.filter((t) => t.readOnly);

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
		if (!tool.readOnly && !options.allowWrites()) {
			let enabled = false;
			try {
				enabled = (await options.requestWrites?.(tool)) === true && options.allowWrites();
			} catch {
				enabled = false;
			}
			if (!enabled) return { isError: true, content: [{ type: 'text', text: WRITES_STAY_OFF_MESSAGE }] };
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
