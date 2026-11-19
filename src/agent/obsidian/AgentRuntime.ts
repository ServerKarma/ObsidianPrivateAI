import { App, TFile } from 'obsidian';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ObsidianVaultAdapter } from './ObsidianVaultAdapter';
import { ImageProcessResult, ImageTextCache, ImageTextSource } from './ImageTextCache';
import { VaultSearch } from '../search/VaultSearch';
import { createVaultTools, describeWorkspace, VaultToolDefinition } from '../tools/vaultTools';
import { askToEnableChanges, createModalConfirm } from './ConfirmChangeModal';
import { createVaultMcpServer } from '../mcp/vaultMcpServer';
import { connectInProcess } from '../mcp/inProcessClient';
import { loadMcpTools } from '../pi/mcpTools';
import { isImage } from '../vault/VaultPort';

export interface AgentRuntimeSettings {
	excludedFolders: string[];
	excludedFilePatterns: string[];
	allowNoteChanges: boolean;
}

export interface AgentRuntimeOptions {
	app: App;
	version: string;
	/** Plugin folder, for the image text cache. */
	pluginDir: string;
	settings: () => AgentRuntimeSettings;
	/** Turns the "allow note changes" setting on and saves it, after the user said yes. */
	enableNoteChanges: () => Promise<void>;
	log?: (message: string, error?: unknown) => void;
}

/**
 * Owns the agent's plumbing inside the plugin: vault adapter, BM25/grep
 * search, the vault tools, the built-in MCP server and the image text cache.
 * The MCP server is in-process only: it has no network listener, and nothing
 * outside Obsidian can reach the vault tools.
 */
export class AgentRuntime {
	readonly vault: ObsidianVaultAdapter;
	readonly search: VaultSearch;
	readonly imageCache: ImageTextCache;
	readonly tools: VaultToolDefinition[];
	private client: Client | null = null;

	constructor(private readonly options: AgentRuntimeOptions) {
		const { app, pluginDir, settings } = options;
		this.vault = new ObsidianVaultAdapter(app);
		this.imageCache = new ImageTextCache(app, `${pluginDir}/image-text-cache.json`);
		this.search = new VaultSearch(this.vault, () => settings(), this.imageCache);
		// Every create/edit/move/delete asks the user in Obsidian first.
		this.tools = createVaultTools({ vault: this.vault, search: this.search, confirm: createModalConfirm(app, () => 'Private AI') });
	}

	async init(): Promise<void> {
		await this.imageCache.load();
	}

	/** A new MCP server instance over the shared vault tools. */
	createMcpServer(): Server {
		return createVaultMcpServer(this.tools, {
			version: this.options.version,
			allowWrites: () => this.options.settings().allowNoteChanges,
			requestWrites: (tool) => this.askToEnableChanges(tool.title),
		});
	}

	private enabling: Promise<boolean> | null = null;

	/** One question at a time: tool calls that arrive while it is open share the answer. */
	private askToEnableChanges(wants: string): Promise<boolean> {
		if (!this.enabling) {
			this.enabling = askToEnableChanges(this.options.app, 'Private AI', wants)
				.then(async (yes) => {
					if (yes) await this.options.enableNoteChanges();
					return yes;
				})
				.finally(() => {
					this.enabling = null;
				});
		}
		return this.enabling;
	}

	private async getClient(): Promise<Client> {
		if (!this.client) this.client = await connectInProcess(this.createMcpServer());
		return this.client;
	}

	/** The MCP server's tools as Pi agent tools (re-listed per run so setting changes apply). */
	async loadAgentTools(): Promise<AgentTool[]> {
		return loadMcpTools(await this.getClient());
	}

	/** The per-turn workspace note: which note is active and which are open (paths only). */
	workspaceContext(): string {
		return `[Obsidian workspace]\n${describeWorkspace(this.vault, this.search)}`;
	}

	warmIndex(): Promise<void> {
		return this.search.refresh();
	}

	private visibleImages(): TFile[] {
		const images = this.options.app.vault.getFiles().filter((f) => isImage(f) && this.search.isVisible(f.path));
		this.imageCache.prune(new Set(images.map((f) => f.path)));
		return images;
	}

	pendingImages(retryEmpty = false): TFile[] {
		return this.imageCache.pending(this.visibleImages(), retryEmpty);
	}

	async processImages(
		source: ImageTextSource,
		onProgress?: (done: number, total: number, path: string) => void,
		signal?: AbortSignal,
		/** Also re-read images where no text was found last time. */
		retryEmpty = false,
	): Promise<ImageProcessResult> {
		const result = await this.imageCache.process(this.visibleImages(), source, onProgress, signal, retryEmpty);
		await this.search.refresh();
		return result;
	}

	async shutdown(): Promise<void> {
		await this.client?.close();
		this.client = null;
		await this.imageCache.save().catch(() => undefined);
	}
}
