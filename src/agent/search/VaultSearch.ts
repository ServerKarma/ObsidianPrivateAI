import { BM25Index, BM25Hit } from './BM25Index';
import { VaultPort, VaultFileInfo, isMarkdown, isImage } from '../vault/VaultPort';
import { ExclusionRules, isExcluded } from '../vault/exclusions';

/** Supplies searchable text for non-markdown files (e.g. vision OCR of images). */
export interface ExtraTextProvider {
	getText(file: VaultFileInfo): string | undefined;
}

export interface GrepOptions {
	regex?: boolean;
	caseSensitive?: boolean;
	pathPrefix?: string;
	limit?: number;
	contextLines?: number;
}

export interface GrepMatch {
	path: string;
	line: number;
	text: string;
}

export interface SearchHit extends BM25Hit {
	kind: 'note' | 'image';
}

const MAX_GREP_LINE = 300;

/**
 * Retrieval over the files on disk: a BM25 index for ranked search and a
 * straight scan for grep. Both re-read only files whose mtime changed, so
 * there is no database to build or migrate.
 */
export class VaultSearch {
	private index = new BM25Index();
	private kinds = new Map<string, 'note' | 'image'>();
	private refreshing: Promise<void> | null = null;

	constructor(
		private readonly vault: VaultPort,
		private readonly getRules: () => ExclusionRules | undefined = () => undefined,
		private readonly extraText?: ExtraTextProvider,
	) {}

	isVisible(path: string): boolean {
		return !isExcluded(path, this.getRules());
	}

	/** Markdown notes the agent may see. */
	notes(): VaultFileInfo[] {
		return this.vault.listFiles().filter((f) => isMarkdown(f) && this.isVisible(f.path));
	}

	get indexedCount(): number {
		return this.index.size;
	}

	/** Brings the index up to date with the vault. Concurrent calls share one pass. */
	refresh(): Promise<void> {
		if (!this.refreshing) {
			this.refreshing = this.doRefresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async doRefresh(): Promise<void> {
		const seen = new Set<string>();
		for (const file of this.vault.listFiles()) {
			if (!this.isVisible(file.path)) continue;
			if (isMarkdown(file)) {
				seen.add(file.path);
				if (this.index.mtimeOf(file.path) === file.mtime) continue;
				try {
					const body = await this.vault.read(file.path);
					this.index.upsert({ path: file.path, title: file.basename, body, mtime: file.mtime });
					this.kinds.set(file.path, 'note');
				} catch {
					// Unreadable file: leave it out of the index.
				}
			} else if (this.extraText && isImage(file)) {
				const text = this.extraText.getText(file);
				if (!text) continue;
				seen.add(file.path);
				// Re-upsert when either the image or its extracted text changed.
				const stamp = file.mtime + text.length;
				if (this.index.mtimeOf(file.path) === stamp) continue;
				this.index.upsert({ path: file.path, title: file.basename, body: text, mtime: stamp });
				this.kinds.set(file.path, 'image');
			}
		}
		for (const path of this.index.paths()) {
			if (!seen.has(path)) {
				this.index.remove(path);
				this.kinds.delete(path);
			}
		}
	}

	async search(query: string, limit = 8, pathPrefix?: string): Promise<SearchHit[]> {
		await this.refresh();
		const prefix = pathPrefix ? pathPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
		const hits = this.index.search(query, limit, prefix ? (p) => p.startsWith(prefix) : undefined);
		return hits.map((h) => ({ ...h, kind: this.kinds.get(h.path) ?? 'note' }));
	}

	async grep(pattern: string, opts: GrepOptions = {}): Promise<GrepMatch[]> {
		const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
		const flags = opts.caseSensitive ? '' : 'i';
		let re: RegExp;
		try {
			re = new RegExp(opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
		} catch (e) {
			throw new Error(`Invalid regular expression: ${(e as Error).message}`);
		}
		const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
		const matches: GrepMatch[] = [];
		const files = this.notes()
			.filter((f) => !prefix || f.path.startsWith(prefix))
			.sort((a, b) => b.mtime - a.mtime);
		for (const file of files) {
			let content: string;
			try {
				content = await this.vault.read(file.path);
			} catch {
				continue;
			}
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (!re.test(lines[i])) continue;
				const line = lines[i].trim();
				matches.push({
					path: file.path,
					line: i + 1,
					text: line.length > MAX_GREP_LINE ? line.slice(0, MAX_GREP_LINE) + '…' : line,
				});
				if (matches.length >= limit) return matches;
			}
		}
		return matches;
	}
}
