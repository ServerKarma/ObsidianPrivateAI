import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Notice } from 'obsidian';
import { ChatView } from './views/ChatView';
import { LoggingUtility } from './utils/LoggingUtility';
import { AgentRuntime } from './agent/obsidian/AgentRuntime';
import { ChatAgentError, PiChatAgent } from './agent/pi/PiChatAgent';
import { imagesUnavailableMessage, noModelsMessage, noToolSupportMessage, noVisionMessage, serverOfflineMessage, smallContextMessage } from './services/modelGuidance';
import { guessServerType, isPresetEndpoint, isServerType, SERVER_CHOICES, ServerType, serverProfile } from './services/localServers';
import { ImageTextExtractor } from './services/ImageTextExtractor';
import { CleanupResult, removeLegacyEmbeddingFiles } from './services/LegacyEmbeddingCleanup';
import '../styles.css';
import manifest from '../manifest.json';
import { ReviewModal, ReviewModalChoice } from './views/ReviewModal';
import { GITHUB_REPO_URL, REVIEW_MODAL_DELAY_MS, REVIEW_PAGE_URL, shouldShowReviewPrompt } from './services/reviewPrompt';

export const CHAT_VIEW_TYPE = 'local-llm-chat-view';

export interface LocalLLMSettings {
	/** Which local server the endpoint belongs to (LM Studio, Ollama, llama.cpp, Jan or another OpenAI-compatible one). */
	serverType: ServerType;
	apiEndpoint: string;
	// User preferences appended to the agent's system prompt
	systemPrompt: string;
	// Model setting (optional - if not set, the first loaded chat model is used)
	model?: string;
	// API key (optional) - if specified, sent as a Bearer token
	apiKey?: string;
	enableDeveloperLogging: boolean;
	// Agent (Pi harness) settings
	allowNoteChanges: boolean;
	maxToolRounds: number;
	// Image processing settings
	enableImageTextExtraction: boolean;
	// Files the agent can't see
	excludedFolders: string[];
	excludedFilePatterns: string[];
	// Context notes visibility setting
	contextNotesVisible: boolean;
	// Review prompt tracking
	usageTimeMs: number;
	lastUsageStartTimestamp: number | null;
	lastReviewPromptTimestamp: number | null;
	reviewLinkClicked: boolean;
	successfulChats: number;
	successfulChatsAtLastReviewPrompt: number;
}

/** The pre-agent default prompt; replaced with an empty preference on load. */
const LEGACY_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant with access to the user's Obsidian vault. When provided with context from their notes, use that information to provide more accurate and relevant responses. Reference specific notes when appropriate, but focus on answering the user's question clearly and concisely.";

/** Settings that no longer exist (the embedding pipeline, the old MCP listener, and the model parameters LM Studio now decides), dropped from data.json on load. */
const REMOVED_SETTINGS = ['searchMaxResults', 'searchContextPercentage', 'searchThreshold', 'enableRAG', 'ragThreshold', 'ragMaxResults', 'embeddingEndpoint', 'embeddingModel', 'contextMode', 'mcpServerEnabled', 'mcpServerPort', 'mcpServerToken', 'contextWindow', 'maxTokens', 'temperature'];

export const DEFAULT_SETTINGS: LocalLLMSettings = {
	serverType: 'lmstudio',
	apiEndpoint: 'http://localhost:1234/v1/chat/completions',
	systemPrompt: '',
	enableDeveloperLogging: false,
	// Read-only until the user turns this on (the agent asks the first time it wants to change a note)
	allowNoteChanges: false,
	maxToolRounds: 8,
	enableImageTextExtraction: true,
	excludedFolders: [],
	excludedFilePatterns: [],
	contextNotesVisible: false,
	usageTimeMs: 0,
	lastUsageStartTimestamp: null,
	lastReviewPromptTimestamp: null,
	reviewLinkClicked: false,
	successfulChats: 0,
	successfulChatsAtLastReviewPrompt: 0
};

/** Below this many tokens of context, the agent has little room left for notes. */
const SMALL_CONTEXT_TOKENS = 16384;

export default class LocalLLMPlugin extends Plugin {
	settings: LocalLLMSettings;
	agentRuntime: AgentRuntime;
	private llmService: any; // LLMService instance for image processing
	private imageProcessing: AbortController | null = null;
	private usageTrackingIntervalId: number | null = null;
	private reviewModalOpen = false;

	async onload() {
		LoggingUtility.initialize();

		await this.loadSettings();
		this.startUsageTracking();

		// Set developer logging based on settings
		LoggingUtility.setDeveloperLoggingEnabled(this.settings.enableDeveloperLogging);

		// Create LLM service for image processing
		const { createLLMService } = await import('./services/LLMService');
		this.llmService = createLLMService({
			apiEndpoint: this.settings.apiEndpoint,
			serverType: this.settings.serverType,
			apiKey: this.settings.apiKey,
			systemPrompt: this.settings.systemPrompt,
			model: this.settings.model
		});

		// Agent runtime: BM25/grep search, vault tools and the built-in MCP server
		this.agentRuntime = new AgentRuntime({
			app: this.app,
			version: this.manifest.version,
			pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			settings: () => this.settings,
			enableNoteChanges: async () => {
				this.settings.allowNoteChanges = true;
				await this.saveSettings();
			},
			log: (message, error) => LoggingUtility.error(message, error)
		});
		try {
			await this.agentRuntime.init();
		} catch (error) {
			LoggingUtility.error('Failed to start the agent runtime:', error);
		}

		this.app.workspace.onLayoutReady(async () => {
			await this.removeLegacyVectorStore();
			await this.agentRuntime.warmIndex();
			if (this.settings.enableImageTextExtraction && this.agentRuntime.pendingImages().length > 0) {
				void this.processImages(true);
			}
		});

		// Register the view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon to open chat
		this.addRibbonIcon('sparkles', 'Open private AI', () => {
			this.activateView();
		});

		// Add command to open chat
		this.addCommand({
			id: 'open-local-llm-chat',
			name: 'Open',
			callback: () => {
				this.activateView();
			}
		});

		this.addCommand({
			id: 'process-images',
			name: 'Read text from images now',
			callback: () => {
				void this.processImages(false);
			}
		});

		// Add settings tab
		this.addSettingTab(new LocalLLMSettingTab(this.app, this));
	}

	async onunload() {
		LoggingUtility.log('Unloading Private AI Chat plugin');

		await this.flushUsageTracking();

		this.imageProcessing?.abort();
		if (this.agentRuntime) {
			await this.agentRuntime.shutdown();
		}
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		let changed = false;
		for (const key of REMOVED_SETTINGS) {
			if (key in data) {
				delete data[key];
				changed = true;
			}
		}
		if (data.systemPrompt === LEGACY_DEFAULT_SYSTEM_PROMPT) {
			data.systemPrompt = '';
			changed = true;
		}
		if (!isServerType(data.serverType)) {
			// Saved before the server choice existed: tell it from the endpoint's port.
			data.serverType = guessServerType(data.apiEndpoint ?? DEFAULT_SETTINGS.apiEndpoint);
			changed = true;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		if (changed) {
			await this.saveData(this.settings);
		}
	}

	/** A Pi agent for one chat view; it reaches the vault through the built-in MCP server. */
	createChatAgent(): PiChatAgent {
		return new PiChatAgent({
			settings: () => ({
				apiEndpoint: this.settings.apiEndpoint,
				apiKey: this.settings.apiKey,
				model: this.settings.model,
				systemPrompt: this.settings.systemPrompt,
				maxToolRounds: this.settings.maxToolRounds
			}),
			loadTools: () => this.agentRuntime.loadAgentTools(),
			resolveModel: async () => {
				// Checked before every message, so the user gets instructions instead of a raw network error.
				const { createLLMService } = await import('./services/LLMService');
				const status = await createLLMService({
					apiEndpoint: this.settings.apiEndpoint,
					serverType: this.settings.serverType,
					apiKey: this.settings.apiKey,
					model: this.settings.model
				}).getServerStatus('tools');
				if (status.state === 'offline') throw new ChatAgentError(serverOfflineMessage(this.settings.apiEndpoint, this.settings.serverType));
				if (status.state === 'no-models') throw new ChatAgentError(noModelsMessage(this.settings.serverType));
				if (status.state !== 'ready') return undefined;
				if (status.model.toolUse === false) throw new ChatAgentError(noToolSupportMessage(status.model.id, this.settings.serverType));
				// The context length the server loaded the model with, when it reports one.
				this.warnIfSmallContext(status.model);
				return { id: status.model.id, contextWindow: status.model.contextLength };
			}
		});
	}

	private smallContextWarned = new Set<string>();

	/**
	 * Says once per model and size when the server runs the model with too little context
	 * for the agent (Ollama's default on smaller machines is 4k). Only for a loaded model,
	 * whose context is known rather than assumed.
	 */
	private warnIfSmallContext(model: { id: string; loaded: boolean; contextLength?: number }): void {
		if (!model.loaded || !model.contextLength || model.contextLength >= SMALL_CONTEXT_TOKENS) return;
		const key = `${model.id}|${model.contextLength}`;
		if (this.smallContextWarned.has(key)) return;
		this.smallContextWarned.add(key);
		new Notice(smallContextMessage(model.id, model.contextLength, this.settings.serverType), 15000);
	}

	/** Reads text out of images with the vision model so search can find it. */
	async processImages(background: boolean): Promise<void> {
		if (this.imageProcessing) {
			if (!background) new Notice('Image text extraction is already running.');
			return;
		}
		const controller = new AbortController();
		this.imageProcessing = controller;
		try {
			const { createLLMService } = await import('./services/LLMService');
			const connection = { apiEndpoint: this.settings.apiEndpoint, serverType: this.settings.serverType, apiKey: this.settings.apiKey, model: this.settings.model };
			const status = await createLLMService(connection).getServerStatus('vision');
			if (status.state === 'offline' || status.state === 'no-models') {
				if (!background) new Notice(imagesUnavailableMessage(status.state, this.settings.serverType), 8000);
				return;
			}
			let visionKnown = false;
			if (status.state === 'ready') {
				if (status.model.vision === false) {
					if (!background) new Notice(noVisionMessage(status.model.id, this.settings.serverType), 10000);
					return;
				}
				// On startup, don't make the server load a model just to read images.
				if (background && !status.model.loaded) return;
				visionKnown = status.model.vision === true;
				connection.model = status.model.id;
			}
			const extractor = new ImageTextExtractor(createLLMService({
				...connection,
				systemPrompt: this.settings.systemPrompt
			}), this.app);
			// Servers that don't report capabilities are asked to describe a test image instead.
			if (!visionKnown && !(await extractor.checkVisionCapabilities())?.supportsVision) {
				if (!background) {
					new Notice(`Vision model required: load a vision model (like Gemma 4) in ${serverProfile(this.settings.serverType).name} to read text from images.`, 8000);
				}
				return;
			}
			const result = await this.agentRuntime.processImages(extractor, (done, total, path) => {
				LoggingUtility.log(`Reading image text ${done}/${total}: ${path}`);
			}, controller.signal, !background); // a manual run also re-reads images that had no text
			if (!background || result.processed > 0) {
				const details = [
					result.empty ? `${result.empty} had no text` : '',
					result.failed ? `${result.failed} could not be read and will be tried again` : ''
				].filter(Boolean).join('; ');
				new Notice(`Private AI read text from ${result.processed} image${result.processed === 1 ? '' : 's'}${details ? ` (${details})` : ''}.`, result.failed ? 8000 : undefined);
			}
		} catch (error) {
			LoggingUtility.error('Image processing failed:', error);
			if (!background) new Notice(`Image processing failed: ${error?.message ?? error}`);
		} finally {
			this.imageProcessing = null;
		}
	}

	/**
	 * Deletes the index files the old embedding pipeline left on disk (SQLite DB and the
	 * older JSON embedding files). Runs on every start, so anything that could not be
	 * removed once is retried next time; it does nothing once they are gone.
	 */
	async removeLegacyVectorStore(): Promise<CleanupResult> {
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const result = await removeLegacyEmbeddingFiles(this.app.vault.adapter, {
			configDir: this.app.vault.configDir,
			pluginDir,
			pluginId: this.manifest.id
		});
		for (const error of result.errors) {
			LoggingUtility.warn('Could not remove old embedding files:', error);
		}
		if (result.removedFiles.length > 0) {
			LoggingUtility.log('Removed old embedding files:', result.removedFiles, result.removedFolders);
			const mb = result.bytesFreed / (1024 * 1024);
			new Notice(`Private AI no longer uses embeddings. Removed the old search index${mb >= 0.1 ? ` (${mb.toFixed(1)} MB)` : ''}.`);
		}
		return result;
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// Update developer logging setting
		LoggingUtility.setDeveloperLoggingEnabled(this.settings.enableDeveloperLogging);

		// Update LLM service config
		if (this.llmService) {
			const { createLLMService } = await import('./services/LLMService');
			this.llmService = createLLMService({
				apiEndpoint: this.settings.apiEndpoint,
				serverType: this.settings.serverType,
				apiKey: this.settings.apiKey,
				systemPrompt: this.settings.systemPrompt,
				model: this.settings.model
			});

		}
	}

	private startUsageTracking() {
		if (this.settings.lastUsageStartTimestamp === null) {
			this.settings.lastUsageStartTimestamp = Date.now();
		}

		this.usageTrackingIntervalId = window.setInterval(() => {
			void this.updateUsage();
		}, 60 * 1000);
		this.registerInterval(this.usageTrackingIntervalId);

		void this.updateUsage();
	}

	private async updateUsage() {
		const now = Date.now();
		const lastStart = this.settings.lastUsageStartTimestamp;

		if (lastStart !== null && now > lastStart) {
			this.settings.usageTimeMs += now - lastStart;
		}

		this.settings.lastUsageStartTimestamp = now;
		await this.saveData(this.settings);
	}

	private async flushUsageTracking() {
		const now = Date.now();
		const lastStart = this.settings.lastUsageStartTimestamp;

		if (lastStart !== null && now > lastStart) {
			this.settings.usageTimeMs += now - lastStart;
		}

		this.settings.lastUsageStartTimestamp = null;
		await this.saveData(this.settings);
	}

	/**
	 * Called by the chat view each time an answer finishes without an error. The review ask is
	 * tied to these moments so it only ever follows a good experience.
	 */
	async recordSuccessfulChat(): Promise<void> {
		this.settings.successfulChats = (this.settings.successfulChats ?? 0) + 1;
		await this.saveData(this.settings);
		if (this.reviewModalOpen || !shouldShowReviewPrompt(this.settings, Date.now())) {
			return;
		}
		window.setTimeout(() => this.showReviewModal(), REVIEW_MODAL_DELAY_MS);
	}

	/** Opens the review modal now. Also used by the settings button for testing. */
	showReviewModal(): void {
		if (this.reviewModalOpen) return;
		this.reviewModalOpen = true;
		this.settings.lastReviewPromptTimestamp = Date.now();
		this.settings.successfulChatsAtLastReviewPrompt = this.settings.successfulChats ?? 0;
		void this.saveData(this.settings);
		new ReviewModal(this.app, this.settings.successfulChats ?? 0, (choice) => {
			this.reviewModalOpen = false;
			void this.handleReviewChoice(choice);
		}).open();
	}

	private async handleReviewChoice(choice: ReviewModalChoice): Promise<void> {
		if (choice === 'later') {
			// Snoozed: it comes back after more days and more answered chats.
			return;
		}
		if (choice === 'review') window.open(REVIEW_PAGE_URL, '_blank');
		if (choice === 'star') window.open(GITHUB_REPO_URL, '_blank');
		this.settings.reviewLinkClicked = true;
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Create a new leaf in the right sidebar
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: CHAT_VIEW_TYPE,
					active: true,
				});
			}
		}

		// Reveal the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}

class LocalLLMSettingTab extends PluginSettingTab {
	plugin: LocalLLMPlugin;

	constructor(app: App, plugin: LocalLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Helper to create a slider with live value label and custom style
		const addStyledSlider = (setting: Setting, opts: {
			min: number, max: number, step: number, value: number, onChange: (value: number) => Promise<void>,
			format?: (value: number) => string
		}) => {
			let valueLabel: HTMLSpanElement | null = null;
			setting.addSlider(slider => {
				slider.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (valueLabel) valueLabel.textContent = opts.format ? opts.format(value) : value.toString();
						await opts.onChange(value);
					});
				slider.sliderEl.classList.add('local-llm-settings-slider');
				// Live update label as slider moves
				slider.sliderEl.addEventListener('input', (e: Event) => {
					const val = parseFloat((e.target as HTMLInputElement).value);
					if (valueLabel) valueLabel.textContent = opts.format ? opts.format(val) : val.toString();
				});
				valueLabel = document.createElement('span');
				valueLabel.className = 'local-llm-slider-value';
				valueLabel.textContent = opts.format ? opts.format(opts.value) : opts.value.toString();
				slider.sliderEl.parentElement?.appendChild(valueLabel);
			});
		};

		const server = serverProfile(this.plugin.settings.serverType);

		new Setting(containerEl)
			.setName('Local server')
			.setDesc('The app that runs the AI model on this computer. Private AI only talks to the server at the endpoint below.')
			.addDropdown(dropdown => {
				for (const choice of SERVER_CHOICES) dropdown.addOption(choice.type, choice.label);
				dropdown.setValue(this.plugin.settings.serverType);
				dropdown.onChange(async (value) => {
					if (!isServerType(value)) return;
					this.plugin.settings.serverType = value;
					// Move to the new server's usual address, unless the user typed their own.
					if (isPresetEndpoint(this.plugin.settings.apiEndpoint)) {
						this.plugin.settings.apiEndpoint = serverProfile(value).defaultEndpoint;
					}
					// A model name from one server means nothing to another.
					this.plugin.settings.model = undefined;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('API endpoint')
			.setDesc(`The OpenAI-compatible chat completions URL of ${server.name}.`)
			.addText(text => text
				.setPlaceholder(server.defaultEndpoint)
				.setValue(this.plugin.settings.apiEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.apiEndpoint = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API key')
			.setDesc(server.apiKeyHelp)
			.addText(text => text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKey ?? '')
				.onChange(async (value) => {
					const trimmedValue = value.trim();
					this.plugin.settings.apiKey = trimmedValue.length > 0 ? trimmedValue : undefined;
					await this.plugin.saveSettings();
				}));

		// Model dropdown setting
		const modelSetting = new Setting(containerEl)
			.setName('Model')
			.setDesc(`Select a specific model to use. (Loaded from the models downloaded in ${server.name}.)`)
			.addDropdown(dropdown => {
				// Add empty option for no model selection
				dropdown.addOption('', 'Auto (server chooses)');

				// Set current value from saved settings
				const savedModel = this.plugin.settings.model || '';
				dropdown.setValue(savedModel);

				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value === '' ? undefined : value;
					await this.plugin.saveSettings();
				});

				// Store reference to dropdown for dynamic updates
				(this as any).modelDropdown = dropdown;
			});

		// Add refresh models button
		modelSetting.addButton(button => button
			.setButtonText('Refresh Models')
			.setTooltip(`Load available models from ${server.name}`)
			.onClick(async () => {
				await this.loadAvailableModels();
			}));

		// Load models automatically when settings are displayed
		// Use setTimeout to ensure the dropdown is fully initialized first
		setTimeout(() => {
			this.loadAvailableModels();
		}, 0);

		// System prompt setting with textarea below
		new Setting(containerEl)
			.setName('What personal preferences should be considered in responses?')
			.setDesc('Customize the AI\'s personality and behavior. This system prompt will be used in all conversations.');

		const systemPromptTextArea = containerEl.createEl('textarea', {
			cls: 'local-llm-system-prompt-textarea',
			attr: {
				placeholder: 'e.g. "You are a helpful assistant. Please be concise and friendly. Consider that I prefer practical examples over theory."',
				rows: '4'
			}
		});
		systemPromptTextArea.value = this.plugin.settings.systemPrompt;

		systemPromptTextArea.addEventListener('input', async () => {
			this.plugin.settings.systemPrompt = systemPromptTextArea.value;
			await this.plugin.saveSettings();
		});

		new Setting(containerEl).setName('Agent').setHeading();

		new Setting(containerEl)
			.setName('Allow editing, deleting, and moving')
			.setDesc('Off by default: the AI can only search and read your notes. The first time it tries to create, edit, move or delete a note, it asks whether to turn this on. When on, every change still opens a dialog and only happens if you click Allow. Deleted notes go to the trash.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowNoteChanges)
				.onChange(async (value) => {
					this.plugin.settings.allowNoteChanges = value;
					await this.plugin.saveSettings();
				}));

		addStyledSlider(
			new Setting(containerEl)
				.setName('Max tool rounds')
				.setDesc('How many rounds of searching and reading the AI may do before it has to answer.'),
			{
				min: 1, max: 20, step: 1, value: this.plugin.settings.maxToolRounds,
				onChange: async (value) => {
					this.plugin.settings.maxToolRounds = value;
					await this.plugin.saveSettings();
				}
			}
		);

		new Setting(containerEl).setName('Files the AI can\'t see').setHeading();

		const excludedFoldersSetting = new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('One folder per line. Supports vault-relative paths (e.g. clippings/_resources) or absolute vault paths.')
			.addTextArea(text => text
				.setPlaceholder('clippings/_resources\nattachments/generated')
				.setValue((this.plugin.settings.excludedFolders || []).join('\n'))
				.then((text) => {
					text.inputEl.rows = 4;
					text.inputEl.addClass('local-llm-exclusion-textarea');
					text.inputEl.addClass('local-llm-exclusion-textarea-large');
				})
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = this.parseMultilineList(value);
					await this.plugin.saveSettings();
				}));
		excludedFoldersSetting.settingEl.addClass('local-llm-exclusion-setting');

		const excludedFilePatternsSetting = new Setting(containerEl)
			.setName('Excluded file patterns')
			.setDesc('One pattern per line. Examples: *.json, *.csv, *.png, Daily/*.tmp')
			.addTextArea(text => text
				.setPlaceholder('*.json\n*.csv\n*.png')
				.setValue((this.plugin.settings.excludedFilePatterns || []).join('\n'))
				.then((text) => {
					text.inputEl.rows = 3;
					text.inputEl.addClass('local-llm-exclusion-textarea');
					text.inputEl.addClass('local-llm-exclusion-textarea-compact');
				})
				.onChange(async (value) => {
					this.plugin.settings.excludedFilePatterns = this.parseMultilineList(value);
					await this.plugin.saveSettings();
				}));
		excludedFilePatternsSetting.settingEl.addClass('local-llm-exclusion-setting');

		new Setting(containerEl).setName('Image text').setHeading();

		new Setting(containerEl)
			.setName('Read text from images')
			.setDesc('Use a vision-capable model to read the text in your images once, so searches can find it. Results are cached in the plugin folder. Requires a vision model such as Gemma 4.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableImageTextExtraction)
				.onChange(async (value) => {
					this.plugin.settings.enableImageTextExtraction = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Process images now')
			.setDesc(`Read text from new or changed images now, and try again on images where none was found. ${this.plugin.agentRuntime ? `Text found in ${this.plugin.agentRuntime.imageCache.withTextCount} of ${this.plugin.agentRuntime.imageCache.count} images read so far.` : ''}`)
			.addButton(button => button
				.setButtonText('Process images')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Processing...');
					button.setDisabled(true);
					try {
						await this.plugin.processImages(false);
					} finally {
						button.setButtonText('Process images');
						button.setDisabled(false);
					}
				}));

		new Setting(containerEl).setName('Support').setHeading();

		new Setting(containerEl)
			.setName('Review prompt')
			.setDesc('Show the review request now. It also appears on its own after you have used the chat for a while.')
			.addButton(button => button
				.setButtonText('Show review prompt')
				.setCta()
				.onClick(() => {
					this.plugin.showReviewModal();
				}));

		// Add developer logging setting
		new Setting(containerEl)
			.setName('Enable developer logging')
			.setDesc('Enable additional logging for debugging')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDeveloperLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDeveloperLogging = value;
					await this.plugin.saveSettings();
				}));

		// Add connection test button
		const testButton = containerEl.createEl('button', {
			text: 'Test connection',
			cls: 'mod-cta'
		});

		testButton.addEventListener('click', async () => {
			testButton.setText('Testing...');
			testButton.disabled = true;

			try {
				// Create a temporary LLM service to test
				const { createLLMService } = await import('./services/LLMService');
				const llmService = createLLMService({
					apiEndpoint: this.plugin.settings.apiEndpoint,
					serverType: this.plugin.settings.serverType,
					apiKey: this.plugin.settings.apiKey,
					systemPrompt: this.plugin.settings.systemPrompt,
					model: this.plugin.settings.model
				});

				// Validate config first
				const validation = llmService.validateConfig();
				if (!validation.valid) {
					throw new Error(`Configuration errors:\n${validation.errors.join('\n')}`);
				}

				// Test connection
				const result = await llmService.testConnection();

				if (result.success) {
					new Notice('Connection successful. Your LLM server is working.');
					testButton.setText('Test connection');
					testButton.disabled = false;
				} else {
					throw new Error(result.error || 'Unknown connection error');
				}
			} catch (error) {
				LoggingUtility.error('Connection test failed:', error);
				new Notice(`Connection failed: ${error.message}`);
				testButton.setText('Test connection');
				testButton.disabled = false;
			}
		});

		// Add spacing between buttons
		containerEl.createEl('br');
		containerEl.createEl('br');

		// Add report problem button
		const reportButton = containerEl.createEl('button', {
			text: 'Report a problem',
			cls: 'mod-cta'
		});

		// Add version display
		containerEl.createEl('p', { text: `Private AI version ${manifest.version}` })

		reportButton.addEventListener('click', () => {
			window.open('https://github.com/gabosgab/ObsidianPrivateAI/issues/new?template=bug_report.md', '_blank');
		});
	}

	/**
	 * Load the models the configured server has downloaded
	 */
	private async loadAvailableModels(): Promise<void> {
		const dropdown = (this as any).modelDropdown;
		if (!dropdown) return;

		try {
			// Show loading state
			const savedModel = this.plugin.settings.model || '';
			dropdown.selectEl.disabled = true;
			dropdown.selectEl.empty();
			dropdown.selectEl.createEl('option', { value: '', text: 'Loading models...' });

			// Create a temporary LLM service to fetch models
			const { createLLMService } = await import('./services/LLMService');
			const llmService = createLLMService({
				apiEndpoint: this.plugin.settings.apiEndpoint,
				serverType: this.plugin.settings.serverType,
				apiKey: this.plugin.settings.apiKey
			});

			// Fetch available models
			const models = await llmService.getAvailableModels();

			// Clear dropdown and add default option
			dropdown.selectEl.empty();
			dropdown.addOption('', 'Auto (server chooses)');

			// Add available models
			if (models.length > 0) {
				models.forEach(model => {
					if (!model.toLowerCase().includes('embed')) {
						dropdown.addOption(model, model);
					}
				});
			} else {
				dropdown.addOption('', 'No models available');
			}

			// Restore saved selection if it still exists
			if (savedModel && models.includes(savedModel)) {
				dropdown.setValue(savedModel);
			} else {
				dropdown.setValue('');
			}

			// Re-enable dropdown
			dropdown.selectEl.disabled = false;

		} catch (error) {
			LoggingUtility.error('Failed to load available models:', error);

			// Show error state
			dropdown.selectEl.empty();
			dropdown.addOption('', 'Auto (server chooses)');
			dropdown.addOption('', 'Failed to load models');

			// Restore saved model even in error state
			const savedModel = this.plugin.settings.model || '';
			dropdown.setValue(savedModel);
			dropdown.selectEl.disabled = false;

			// Show notice to user
			const name = serverProfile(this.plugin.settings.serverType).name;
			new Notice(`Failed to load models from ${name}. Please check your API endpoint and ensure ${name} is running.`);
		}
	}

	private parseMultilineList(value: string): string[] {
		return value
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);
	}
}
