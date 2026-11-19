import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface McpHttpHostOptions {
	port: number;
	/** Bearer token every request must carry. */
	token: string;
	/** Builds a fresh MCP server per request (stateless Streamable HTTP). */
	createServer: () => Server;
	log?: (message: string, error?: unknown) => void;
}

export const MCP_HTTP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				const text = Buffer.concat(chunks).toString('utf8');
				resolve(text ? JSON.parse(text) : undefined);
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

function sendJsonError(res: http.ServerResponse, status: number, message: string): void {
	if (res.headersSent) return;
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves the built-in MCP server on http://127.0.0.1:<port>/mcp so external
 * MCP clients can use the vault tools. Loopback only, bearer-token protected,
 * with DNS-rebinding protection. Off unless enabled in settings.
 */
export class McpHttpHost {
	private server: http.Server | null = null;

	constructor(private readonly options: McpHttpHostOptions) {}

	get url(): string {
		return `http://127.0.0.1:${this.options.port}${MCP_HTTP_PATH}`;
	}

	get isRunning(): boolean {
		return this.server !== null;
	}

	start(): Promise<void> {
		if (this.server) return Promise.resolve();
		const { port, token, createServer, log } = this.options;
		const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

		const httpServer = http.createServer(async (req, res) => {
			try {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
				const reject = (status: number, message: string) => {
					req.resume(); // drain the body so the connection can be reused
					sendJsonError(res, status, message);
				};
				if (url.pathname !== MCP_HTTP_PATH) return reject(404, 'Not found');
				if (req.headers.authorization !== `Bearer ${token}`) return reject(401, 'Missing or wrong bearer token');
				if (req.method !== 'POST') {
					res.setHeader('Allow', 'POST');
					return reject(405, 'This server is stateless; use POST');
				}
				const body = await readJsonBody(req);
				const mcp = createServer();
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
					enableDnsRebindingProtection: true,
					allowedHosts,
				});
				res.on('close', () => {
					void transport.close();
					void mcp.close();
				});
				await mcp.connect(transport);
				await transport.handleRequest(req, res, body);
			} catch (error) {
				log?.('MCP HTTP request failed', error);
				sendJsonError(res, 500, 'Internal error');
			}
		});

		return new Promise((resolve, reject) => {
			httpServer.once('error', reject);
			httpServer.listen(port, '127.0.0.1', () => {
				httpServer.off('error', reject);
				this.server = httpServer;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		const s = this.server;
		this.server = null;
		if (!s) return Promise.resolve();
		return new Promise((resolve) => {
			s.close(() => resolve());
			// Also drop idle keep-alive sockets so the port is really released.
			s.closeAllConnections?.();
		});
	}
}
