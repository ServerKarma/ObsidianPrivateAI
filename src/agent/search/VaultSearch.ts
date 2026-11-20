import { BM25Index, BM25Hit } from './BM25Index';
import { VaultPort, VaultFileInfo, isMarkdown, isImage } from '../vault/VaultPort';
import { ExclusionRules, isExcluded } from '../vault/exclusions';
import { extractTags, hasAllTags } from './tags';

/** Supplies searchable text for non-markdown files (e.g. vision OCR of images). */
export interface ExtraTextProvider {
	getText(file: VaultFileInfo): string | undefined;
}

export interface GrepOptions {
	regex?: boolean;
	caseSensitive?: boolean;
	pathPrefix?: string;
	/** Only notes that carry every one of these tags (nested tags count). */
	tags?: string[];
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
	/** Tags of each indexed note, refreshed together with the index. */
	private tags = new Map<string, string[]>();
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
					this.tags.set(file.path, extractTags(body));
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
				this.tags.delete(path);
			}
		}
	}

	/** Tags of a visible note (lowercase, no "#"), as of the last refresh. */
	tagsOf(path: string): string[] {
		return this.tags.get(path) ?? [];
	}

	/** True when the note carries every wanted tag; no tags wanted means every note matches. */
	private matchesTags(path: string, wanted: string[] | undefined): boolean {
		return !wanted || wanted.length === 0 || hasAllTags(this.tagsOf(path), wanted);
	}

	/** Every tag in the visible notes with how many notes use it, most used first. */
	async tagCounts(): Promise<Array<{ tag: string; count: number }>> {
		await this.refresh();
		const counts = new Map<string, number>();
		for (const tags of this.tags.values()) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	}

	/** Visible notes that carry every wanted tag. */
	async notesWithTags(wanted: string[]): Promise<VaultFileInfo[]> {
		await this.refresh();
		return this.notes().filter((f) => this.matchesTags(f.path, wanted));
	}

	async search(query: string, limit = 8, pathPrefix?: string, tags?: string[]): Promise<SearchHit[]> {
		await this.refresh();
		const prefix = pathPrefix ? pathPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
		const wanted = tags && tags.length > 0 ? tags : undefined;
		const filter =
			prefix || wanted
				? (p: string) => (!prefix || p.startsWith(prefix)) && (!wanted || (this.kinds.get(p) === 'note' && this.matchesTags(p, wanted)))
				: undefined;
		const hits = this.index.search(query, limit, filter);
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
		const files = (opts.tags && opts.tags.length > 0 ? await this.notesWithTags(opts.tags) : this.notes())
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
