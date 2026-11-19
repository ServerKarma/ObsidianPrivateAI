import { App, TFile } from 'obsidian';
import { ExtraTextProvider } from '../search/VaultSearch';
import { VaultFileInfo, isImage } from '../vault/VaultPort';

interface CacheEntry {
	mtime: number;
	size: number;
	text: string;
}

const CACHE_VERSION = 2;

interface CacheFile {
	version: number;
	entries: Record<string, CacheEntry>;
}

export interface ImageTextSource {
	/**
	 * `failed` means the model could not be asked (request error, empty reply), as opposed
	 * to the model looking at the image and finding no text.
	 */
	extractTextFromImage(file: TFile): Promise<{ success: boolean; extractedText: string; error?: string; failed?: boolean }>;
}

export interface ImageProcessResult {
	/** Images text was read from. */
	processed: number;
	/** Images the model looked at and found no text in. */
	empty: number;
	/** Images that could not be read this time; they are tried again on the next run. */
	failed: number;
}

/**
 * Text that a vision model read out of images, kept in one JSON file in the
 * plugin folder (keyed by image path, invalidated by mtime/size). Feeds the
 * BM25 index so image content is searchable without embeddings.
 */
export class ImageTextCache implements ExtraTextProvider {
	private entries: Record<string, CacheEntry> = {};
	private saveTimer: number | null = null;

	constructor(private readonly app: App, private readonly filePath: string) {}

	async load(): Promise<void> {
		try {
			if (await this.app.vault.adapter.exists(this.filePath)) {
				const parsed = JSON.parse(await this.app.vault.adapter.read(this.filePath)) as CacheFile;
				const entries = parsed?.entries ?? {};
				// Version 1 also recorded failed requests as "no text", which then were never
				// retried. Those can't be told apart from real blanks, so read them all again.
				this.entries = parsed?.version === CACHE_VERSION
					? entries
					: Object.fromEntries(Object.entries(entries).filter(([, e]) => !!e?.text));
			}
		} catch {
			this.entries = {};
		}
	}

	get count(): number {
		return Object.keys(this.entries).length;
	}

	/** How many images have text that search can find. */
	get withTextCount(): number {
		return Object.values(this.entries).filter((e) => !!e.text).length;
	}

	getText(file: VaultFileInfo): string | undefined {
		const entry = this.entries[file.path];
		if (!entry || entry.mtime !== file.mtime || entry.size !== file.size) return undefined;
		return entry.text || undefined;
	}

	/** Images whose text is missing or stale; with `retryEmpty`, also those where no text was found. */
	pending(files: TFile[], retryEmpty = false): TFile[] {
		return files.filter((f) => {
			if (!isImage(f)) return false;
			const e = this.entries[f.path];
			return !e || e.mtime !== f.stat.mtime || e.size !== f.stat.size || (retryEmpty && !e.text);
		});
	}

	async process(
		files: TFile[],
		source: ImageTextSource,
		onProgress?: (done: number, total: number, path: string) => void,
		signal?: AbortSignal,
		retryEmpty = false,
	): Promise<ImageProcessResult> {
		const todo = this.pending(files, retryEmpty);
		let processed = 0;
		let empty = 0;
		let failed = 0;
		for (let i = 0; i < todo.length; i++) {
			if (signal?.aborted) break;
			const file = todo[i];
			onProgress?.(i, todo.length, file.path);
			let result: Awaited<ReturnType<ImageTextSource['extractTextFromImage']>>;
			try {
				result = await source.extractTextFromImage(file);
			} catch (error) {
				result = { success: false, extractedText: '', failed: true, error: String(error) };
			}
			const text = result.success ? result.extractedText.trim() : '';
			if (!text && result.failed) {
				// Nothing was learned about this image: leave it pending so the next run retries it.
				failed++;
				continue;
			}
			// "No text" is recorded too, so a blank image isn't re-read until it changes.
			this.entries[file.path] = { mtime: file.stat.mtime, size: file.stat.size, text };
			if (text) processed++;
			else empty++;
			this.scheduleSave();
		}
		onProgress?.(todo.length, todo.length, '');
		await this.save();
		return { processed, empty, failed };
	}

	/** Drops entries for images that no longer exist. */
	prune(existing: Set<string>): void {
		for (const path of Object.keys(this.entries)) if (!existing.has(path)) delete this.entries[path];
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 2000);
	}

	async save(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const data: CacheFile = { version: CACHE_VERSION, entries: this.entries };
		await this.app.vault.adapter.write(this.filePath, JSON.stringify(data));
	}
}
