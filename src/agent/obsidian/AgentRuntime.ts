import { App, TFile } from 'obsidian';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ObsidianVaultAdapter } from './ObsidianVaultAdapter';
import { ImageTextCache, ImageTextSource } from './ImageTextCache';
import { VaultSearch } from '../search/VaultSearch';
import { createVaultTools, VaultToolDefinition } from '../tools/vaultTools';
import { createVaultMcpServer } from '../mcp/vaultMcpServer';
import { connectInProcess } from '../mcp/inProcessClient';
import { McpHttpHost } from '../mcp/McpHttpHost';
import { loadMcpTools } from '../pi/mcpTools';
import { isImage } from '../vault/VaultPort';

export interface AgentRuntimeSettings {
	excludedFolders: string[];
	excludedFilePatterns: string[];
	allowNoteChanges: boolean;
	mcpServerEnabled: boolean;
	mcpServerPort: number;
	mcpServerToken: string;
}

export interface AgentRuntimeOptions {
	app: App;
	version: string;
	/** Plugin folder, for the image text cache. */
	pluginDir: string;
	settings: () => AgentRuntimeSettings;
	log?: (message: string, error?: unknown) => void;
}

/**
 * Owns the agent's plumbing inside the plugin: vault adapter, BM25/grep
 * search, the vault tools, the built-in MCP server (in-process for the Pi
 * agent, optionally on localhost for other clients) and the image text cache.
 */
export class AgentRuntime {
	readonly vault: ObsidianVaultAdapter;
	readonly search: VaultSearch;
	readonly imageCache: ImageTextCache;
	readonly tools: VaultToolDefinition[];
	private client: Client | null = null;
	private httpHost: McpHttpHost | null = null;
	private httpKey = '';

	constructor(private readonly options: AgentRuntimeOptions) {
		const { app, pluginDir, settings } = options;
		this.vault = new ObsidianVaultAdapter(app);
		this.imageCache = new ImageTextCache(app, `${pluginDir}/image-text-cache.json`);
		this.search = new VaultSearch(this.vault, () => settings(), this.imageCache);
		this.tools = createVaultTools({ vault: this.vault, search: this.search });
	}

	async init(): Promise<void> {
		await this.imageCache.load();
		await this.applyServerSettings();
	}

	/** A new MCP server instance over the shared vault tools. */
	createMcpServer(): Server {
		return createVaultMcpServer(this.tools, {
			version: this.options.version,
			allowWrites: () => this.options.settings().allowNoteChanges,
		});
	}

	private async getClient(): Promise<Client> {
		if (!this.client) this.client = await connectInProcess(this.createMcpServer());
		return this.client;
	}

	/** The MCP server's tools as Pi agent tools (re-listed per run so setting changes apply). */
	async loadAgentTools(): Promise<AgentTool[]> {
		return loadMcpTools(await this.getClient());
	}

	get mcpUrl(): string | null {
		return this.httpHost?.isRunning ? this.httpHost.url : null;
	}

	/** Starts, restarts or stops the localhost MCP endpoint to match settings. */
	async applyServerSettings(): Promise<void> {
		const s = this.options.settings();
		const key = s.mcpServerEnabled ? `${s.mcpServerPort}:${s.mcpServerToken}` : '';
		if (key === this.httpKey && (!key || this.httpHost?.isRunning)) return;
		if (this.httpHost) {
			await this.httpHost.stop();
			this.httpHost = null;
		}
		this.httpKey = key;
		if (!key) return;
		const host = new McpHttpHost({
			port: s.mcpServerPort,
			token: s.mcpServerToken,
			createServer: () => this.createMcpServer(),
			log: this.options.log,
		});
		try {
			await host.start();
			this.httpHost = host;
		} catch (error) {
			this.httpKey = '';
			throw error;
		}
	}

	/** Warms the BM25 index so the first question doesn't pay for it. */
	warmIndex(): Promise<void> {
		return this.search.refresh();
	}

	pendingImages(): TFile[] {
		const images = this.options.app.vault.getFiles().filter((f) => isImage(f) && this.search.isVisible(f.path));
		this.imageCache.prune(new Set(images.map((f) => f.path)));
		return this.imageCache.pending(images);
	}

	async processImages(
		source: ImageTextSource,
		onProgress?: (done: number, total: number, path: string) => void,
		signal?: AbortSignal,
	): Promise<{ processed: number; failed: number }> {
		const result = await this.imageCache.process(this.pendingImages(), source, onProgress, signal);
		await this.search.refresh();
		return result;
	}

	async shutdown(): Promise<void> {
		await this.httpHost?.stop();
		this.httpHost = null;
		await this.client?.close();
		this.client = null;
		await this.imageCache.save().catch(() => undefined);
	}
}
