import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Notice } from 'obsidian';
import { ChatView } from './views/ChatView';
import { LoggingUtility } from './utils/LoggingUtility';
import { AgentRuntime } from './agent/obsidian/AgentRuntime';
import { ChatAgentError, PiChatAgent } from './agent/pi/PiChatAgent';
import { imagesUnavailableMessage, noModelsMessage, noToolSupportMessage, noVisionMessage, serverOfflineMessage } from './services/modelGuidance';
import { ImageTextExtractor } from './services/ImageTextExtractor';
import { CleanupResult, removeLegacyEmbeddingFiles } from './services/LegacyEmbeddingCleanup';
import '../styles.css';
import manifest from '../manifest.json';

export const CHAT_VIEW_TYPE = 'local-llm-chat-view';

export interface LocalLLMSettings {
	apiEndpoint: string;
	maxTokens: number;
	temperature: number;
	// User preferences appended to the agent's system prompt
	systemPrompt: string;
	// Model setting (optional - if not set, the first loaded chat model is used)
	model?: string;
	// API key (optional) - if specified, used as a Bearer token (works with LM Studio)
	apiKey?: string;
	enableDeveloperLogging: boolean;
	// Agent (Pi harness) settings
	allowNoteChanges: boolean;
	maxToolRounds: number;
	contextWindow: number;
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
}

/** The pre-agent default prompt; replaced with an empty preference on load. */
const LEGACY_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant with access to the user's Obsidian vault. When provided with context from their notes, use that information to provide more accurate and relevant responses. Reference specific notes when appropriate, but focus on answering the user's question clearly and concisely.";

/** Settings from the removed embedding/vector-store pipeline, dropped from data.json on load. */
const REMOVED_SETTINGS = ['searchMaxResults', 'searchContextPercentage', 'searchThreshold', 'enableRAG', 'ragThreshold', 'ragMaxResults', 'embeddingEndpoint', 'embeddingModel', 'contextMode', 'mcpServerEnabled', 'mcpServerPort', 'mcpServerToken'];

export const DEFAULT_SETTINGS: LocalLLMSettings = {
	apiEndpoint: 'http://localhost:1234/v1/chat/completions',
	maxTokens: 10000,
	temperature: 0.7,
	systemPrompt: '',
	enableDeveloperLogging: false,
	allowNoteChanges: true,
	maxToolRounds: 8,
	contextWindow: 32768,
	enableImageTextExtraction: true,
	excludedFolders: [],
	excludedFilePatterns: [],
	contextNotesVisible: false,
	usageTimeMs: 0,
	lastUsageStartTimestamp: null,
	lastReviewPromptTimestamp: null,
	reviewLinkClicked: false
};

const REVIEW_PROMPT_THRESHOLD_MS = 60 * 60 * 1000;
const REVIEW_PROMPT_REPEAT_MS = 24 * 60 * 60 * 1000;
const REVIEW_PAGE_URL = 'https://www.obsidianstats.com/plugins/private-ai';
const REVIEW_PROMPT_MESSAGE = 'Enjoying Private AI? A quick review helps others discover it';

export default class LocalLLMPlugin extends Plugin {
	settings: LocalLLMSettings;
	agentRuntime: AgentRuntime;
	private llmService: any; // LLMService instance for image processing
	private imageProcessing: AbortController | null = null;
	private usageTrackingIntervalId: number | null = null;
	private reviewPromptPending = false;

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
			apiKey: this.settings.apiKey,
			maxTokens: this.settings.maxTokens,
			temperature: this.settings.temperature,
			systemPrompt: this.settings.systemPrompt,
			model: this.settings.model
		});

		// Agent runtime: BM25/grep search, vault tools and the built-in MCP server
		this.agentRuntime = new AgentRuntime({
			app: this.app,
			version: this.manifest.version,
			pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			settings: () => this.settings,
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
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
				systemPrompt: this.settings.systemPrompt,
				maxToolRounds: this.settings.maxToolRounds,
				contextWindow: this.settings.contextWindow
			}),
			loadTools: () => this.agentRuntime.loadAgentTools(),
			resolveModelId: async () => {
				// Checked before every message, so the user gets instructions instead of a raw network error.
				const { createLLMService } = await import('./services/LLMService');
				const status = await createLLMService({
					apiEndpoint: this.settings.apiEndpoint,
					apiKey: this.settings.apiKey,
					model: this.settings.model
				}).getServerStatus('tools');
				if (status.state === 'offline') throw new ChatAgentError(serverOfflineMessage(this.settings.apiEndpoint));
				if (status.state === 'no-models') throw new ChatAgentError(noModelsMessage());
				if (status.state !== 'ready') return undefined;
				if (status.model.toolUse === false) throw new ChatAgentError(noToolSupportMessage(status.model.id));
				return status.model.id;
			}
		});
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
			const connection = { apiEndpoint: this.settings.apiEndpoint, apiKey: this.settings.apiKey, model: this.settings.model };
			const status = await createLLMService(connection).getServerStatus('vision');
			if (status.state === 'offline' || status.state === 'no-models') {
				if (!background) new Notice(imagesUnavailableMessage(status.state), 8000);
				return;
			}
			let visionKnown = false;
			if (status.state === 'ready') {
				if (status.model.vision === false) {
					if (!background) new Notice(noVisionMessage(status.model.id), 10000);
					return;
				}
				// On startup, don't make the server load a model just to read images.
				if (background && !status.model.loaded) return;
				visionKnown = status.model.vision === true;
				connection.model = status.model.id;
			}
			const extractor = new ImageTextExtractor(createLLMService({
				...connection,
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
				systemPrompt: this.settings.systemPrompt
			}), this.app);
			// Servers that don't report capabilities are asked to describe a test image instead.
			if (!visionKnown && !(await extractor.checkVisionCapabilities())?.supportsVision) {
				if (!background) {
					new Notice('Vision model required: load a vision model (like Gemma 4) in LM Studio to read text from images.', 8000);
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
				apiKey: this.settings.apiKey,
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
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
			void this.updateUsageAndMaybeShowReviewPrompt();
		}, 60 * 1000);
		this.registerInterval(this.usageTrackingIntervalId);

		void this.updateUsageAndMaybeShowReviewPrompt();
	}

	private async updateUsageAndMaybeShowReviewPrompt() {
		const now = Date.now();
		const lastStart = this.settings.lastUsageStartTimestamp;

		if (lastStart !== null && now > lastStart) {
			this.settings.usageTimeMs += now - lastStart;
		}

		this.settings.lastUsageStartTimestamp = now;
		await this.saveData(this.settings);

		if (this.shouldShowReviewPrompt(now)) {
			this.settings.lastReviewPromptTimestamp = now;
			await this.saveData(this.settings);
			this.showReviewPromptInChat();
		}
	}

	private shouldShowReviewPrompt(now: number): boolean {
		if (this.settings.reviewLinkClicked) {
			return false;
		}

		if (this.settings.usageTimeMs < REVIEW_PROMPT_THRESHOLD_MS) {
			return false;
		}

		if (this.settings.lastReviewPromptTimestamp === null) {
			return true;
		}

		return now - this.settings.lastReviewPromptTimestamp >= REVIEW_PROMPT_REPEAT_MS;
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

	private showReviewPromptInChat() {
		const injected = this.notifyChatViewsOfReviewPrompt();
		if (injected) {
			return;
		}

		// Queue for next chat view render and open the chat view for immediate visibility.
		this.reviewPromptPending = true;
		void this.activateView().then(() => {
			const wasInjected = this.notifyChatViewsOfReviewPrompt();
			if (wasInjected) {
				this.reviewPromptPending = false;
			}
		});
	}

	openReviewPromptManually() {
		this.showReviewPromptInChat();
	}

	async markReviewLinkClicked() {
		if (this.settings.reviewLinkClicked) {
			return;
		}

		this.settings.reviewLinkClicked = true;
		this.reviewPromptPending = false;
		await this.saveData(this.settings);
	}

	consumePendingReviewPrompt(chatView: ChatView) {
		if (!this.reviewPromptPending) {
			return;
		}

		chatView.showReviewPromptBanner(REVIEW_PROMPT_MESSAGE, REVIEW_PAGE_URL);
		this.reviewPromptPending = false;
	}

	private notifyChatViewsOfReviewPrompt(): boolean {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		let injected = false;

		leaves.forEach(leaf => {
			const chatView = leaf.view as ChatView;
			if (chatView && typeof chatView.showReviewPromptBanner === 'function') {
				chatView.showReviewPromptBanner(REVIEW_PROMPT_MESSAGE, REVIEW_PAGE_URL);
				injected = true;
			}
		});

		return injected;
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

		new Setting(containerEl)
			.setName('API endpoint')
			.setDesc('The endpoint URL for your local LLM API')
			.addText(text => text
				.setPlaceholder('http://localhost:1234/v1/chat/completions')
				.setValue(this.plugin.settings.apiEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.apiEndpoint = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Optional API key sent as a Bearer token for API authentication.  To generate, goto LM Studio, click Developer tab, Server Settings, and click Manage Tokens')
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
			.setDesc('Select a specific model to use. (Loaded from LM Studio downloaded models.)')
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
			.setTooltip('Load available models from LM Studio')
			.onClick(async () => {
				await this.loadAvailableModels();
			}));

		// Load models automatically when settings are displayed
		// Use setTimeout to ensure the dropdown is fully initialized first
		setTimeout(() => {
			this.loadAvailableModels();
		}, 0);

		addStyledSlider(
			new Setting(containerEl)
				.setName('Max tokens')
				.setDesc('Maximum number of tokens in the response'),
			{
				min: 100, max: 40000, step: 100, value: this.plugin.settings.maxTokens,
				onChange: async (value) => {
					this.plugin.settings.maxTokens = value;
					await this.plugin.saveSettings();
				}
			}
		);

		addStyledSlider(
			new Setting(containerEl)
				.setName('Temperature')
				.setDesc('Controls randomness in the response (0 = deterministic, 1 = very random) 0.7 is recommended for most models'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.temperature,
				onChange: async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

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
			.setName('Allow note changes')
			.setDesc('Let the AI create, edit, move and delete notes when you ask it to. Every change opens a dialog and only happens if you click Allow. Deleted notes go to the trash. When off, it can only search and read.')
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

		addStyledSlider(
			new Setting(containerEl)
				.setName('Context window')
				.setDesc('The model\'s context length in tokens (match the value you load the model with in LM Studio). Older messages are dropped to fit.'),
			{
				min: 4096, max: 131072, step: 4096, value: this.plugin.settings.contextWindow,
				onChange: async (value) => {
					this.plugin.settings.contextWindow = value;
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
			.setDesc('Inject the review prompt into the chat window for testing.')
			.addButton(button => button
				.setButtonText('Show review prompt')
				.setCta()
				.onClick(() => {
					this.plugin.openReviewPromptManually();
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
					apiKey: this.plugin.settings.apiKey,
					maxTokens: this.plugin.settings.maxTokens,
					temperature: this.plugin.settings.temperature,
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
	 * Load available models from the LM Studio /v1/models endpoint
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
			new Notice('Failed to load models from LM Studio. Please check your API endpoint and ensure LM Studio is running.');
		}
	}

	private parseMultilineList(value: string): string[] {
		return value
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);
	}
}
