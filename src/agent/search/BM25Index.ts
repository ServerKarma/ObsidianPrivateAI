import { stripMarkdown, tokenize } from './tokenize';

export interface IndexDocument {
	path: string;
	title: string;
	body: string;
	mtime: number;
}

export interface BM25Hit {
	path: string;
	title: string;
	score: number;
	snippet: string;
}

interface Posting {
	doc: IndexedDoc;
	tf: number;
}

interface IndexedDoc {
	source: IndexDocument;
	length: number;
	terms: Map<string, number>;
}

/** Title terms count this many times, so a match in the note name ranks higher. */
const TITLE_WEIGHT = 3;

/**
 * In-memory Okapi BM25 index (k1 = 1.2, b = 0.75) over title + body.
 * Replaces the old embedding/vector-store retrieval: the agent can reformulate
 * and search again, so lexical ranking plus grep covers what embeddings did.
 */
export class BM25Index {
	private docs = new Map<string, IndexedDoc>();
	private postings = new Map<string, Posting[]>();
	private totalLength = 0;
	private dirty = false;

	constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

	get size(): number {
		return this.docs.size;
	}

	has(path: string): boolean {
		return this.docs.has(path);
	}

	mtimeOf(path: string): number | undefined {
		return this.docs.get(path)?.source.mtime;
	}

	paths(): string[] {
		return [...this.docs.keys()];
	}

	upsert(doc: IndexDocument): void {
		this.remove(doc.path);
		const terms = new Map<string, number>();
		const titleTokens = tokenize(`${doc.title} ${doc.path.replace(/[/.]/g, ' ')}`);
		for (const t of titleTokens) terms.set(t, (terms.get(t) ?? 0) + TITLE_WEIGHT);
		const bodyTokens = tokenize(stripMarkdown(doc.body));
		for (const t of bodyTokens) terms.set(t, (terms.get(t) ?? 0) + 1);
		const length = titleTokens.length * TITLE_WEIGHT + bodyTokens.length;
		this.docs.set(doc.path, { source: doc, length, terms });
		this.totalLength += length;
		this.dirty = true;
	}

	remove(path: string): void {
		const existing = this.docs.get(path);
		if (!existing) return;
		this.docs.delete(path);
		this.totalLength -= existing.length;
		this.dirty = true;
	}

	private rebuildPostings(): void {
		this.postings.clear();
		for (const doc of this.docs.values()) {
			for (const [term, tf] of doc.terms) {
				let list = this.postings.get(term);
				if (!list) {
					list = [];
					this.postings.set(term, list);
				}
				list.push({ doc, tf });
			}
		}
		this.dirty = false;
	}

	search(query: string, limit = 10, filter?: (path: string) => boolean): BM25Hit[] {
		if (this.dirty) this.rebuildPostings();
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || this.docs.size === 0) return [];

		const n = this.docs.size;
		const avgLength = this.totalLength / n || 1;
		const scores = new Map<IndexedDoc, number>();

		for (const term of queryTerms) {
			const list = this.postings.get(term);
			if (!list) continue;
			const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
			for (const { doc, tf } of list) {
				if (filter && !filter(doc.source.path)) continue;
				const norm = tf + this.k1 * (1 - this.b + this.b * (doc.length / avgLength));
				const s = idf * ((tf * (this.k1 + 1)) / norm);
				scores.set(doc, (scores.get(doc) ?? 0) + s);
			}
		}

		return [...scores.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([doc, score]) => ({
				path: doc.source.path,
				title: doc.source.title,
				score: Math.round(score * 1000) / 1000,
				snippet: bestSnippet(doc.source.body, queryTerms),
			}));
	}
}

/** Picks the ~3-line window with the most distinct query-term hits. */
export function bestSnippet(body: string, queryTerms: string[], maxChars = 280): string {
	const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
	if (lines.length === 0) return '';
	const wanted = new Set(queryTerms);
	let bestIdx = 0;
	let bestHits = -1;
	for (let i = 0; i < lines.length; i++) {
		const windowTerms = new Set(tokenize(lines.slice(i, i + 3).join(' ')));
		let hits = 0;
		for (const t of wanted) if (windowTerms.has(t)) hits++;
		if (hits > bestHits) {
			bestHits = hits;
			bestIdx = i;
		}
	}
	const text = lines.slice(bestIdx, bestIdx + 3).join(' ⏎ ');
	return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}
