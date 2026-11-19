import { App, TFile } from 'obsidian';
import { ExtraTextProvider } from '../search/VaultSearch';
import { VaultFileInfo, isImage } from '../vault/VaultPort';

interface CacheEntry {
	mtime: number;
	size: number;
	text: string;
}

interface CacheFile {
	version: 1;
	entries: Record<string, CacheEntry>;
}

export interface ImageTextSource {
	extractTextFromImage(file: TFile): Promise<{ success: boolean; extractedText: string; error?: string }>;
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
				this.entries = parsed?.entries ?? {};
			}
		} catch {
			this.entries = {};
		}
	}

	get count(): number {
		return Object.keys(this.entries).length;
	}

	getText(file: VaultFileInfo): string | undefined {
		const entry = this.entries[file.path];
		if (!entry || entry.mtime !== file.mtime || entry.size !== file.size) return undefined;
		return entry.text || undefined;
	}

	/** Images whose text is missing or stale. */
	pending(files: TFile[]): TFile[] {
		return files.filter((f) => {
			if (!isImage(f)) return false;
			const e = this.entries[f.path];
			return !e || e.mtime !== f.stat.mtime || e.size !== f.stat.size;
		});
	}

	async process(
		files: TFile[],
		source: ImageTextSource,
		onProgress?: (done: number, total: number, path: string) => void,
		signal?: AbortSignal,
	): Promise<{ processed: number; failed: number }> {
		const todo = this.pending(files);
		let processed = 0;
		let failed = 0;
		for (let i = 0; i < todo.length; i++) {
			if (signal?.aborted) break;
			const file = todo[i];
			onProgress?.(i, todo.length, file.path);
			const result = await source.extractTextFromImage(file);
			// Record failures with empty text too, so they aren't retried until the image changes.
			this.entries[file.path] = { mtime: file.stat.mtime, size: file.stat.size, text: result.success ? result.extractedText : '' };
			if (result.success) processed++;
			else failed++;
			this.scheduleSave();
		}
		onProgress?.(todo.length, todo.length, '');
		await this.save();
		return { processed, failed };
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
		const data: CacheFile = { version: 1, entries: this.entries };
		await this.app.vault.adapter.write(this.filePath, JSON.stringify(data));
	}
}
