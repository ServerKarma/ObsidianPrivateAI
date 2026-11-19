// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const AGENT_DIR = join(__dirname, '../../src/agent');
// The only folder allowed to touch Obsidian APIs.
const ADAPTER_DIR = join(AGENT_DIR, 'obsidian');

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
	});
}

describe('agent platform boundary', () => {
	it('keeps obsidian, DOM and legacy RAG code out of src/agent (except the adapter folder)', () => {
		const offenders: string[] = [];
		for (const file of walk(AGENT_DIR)) {
			if (file.startsWith(ADAPTER_DIR)) continue;
			const src = readFileSync(file, 'utf8');
			if (/from ['"]obsidian['"]|require\(['"]obsidian['"]\)/.test(src)) offenders.push(`${relative(AGENT_DIR, file)}: imports obsidian`);
			if (/\b(document|window)\./.test(src)) offenders.push(`${relative(AGENT_DIR, file)}: uses the DOM`);
			if (/\.\.\/(services|views|db)\//.test(src)) offenders.push(`${relative(AGENT_DIR, file)}: imports plugin code`);
		}
		expect(offenders).toEqual([]);
	});

	it('has no vector store or embedding code left', () => {
		const src = walk(join(__dirname, '../../src')).map((f) => readFileSync(f, 'utf8')).join('\n');
		expect(src).not.toMatch(/sql\.js|UnifiedVectorDatabase|EmbeddingService|RAGService/);
	});

	it('never exposes the vault outside Obsidian (no servers, sockets or MCP network transports)', () => {
		const offenders = walk(join(__dirname, '../../src')).filter((f) =>
			/['"](node:)?(http|https|net|tls|dgram|ws)['"]|server\/(streamableHttp|sse|stdio)|\.listen\(|createServer\(/.test(readFileSync(f, 'utf8')),
		);
		expect(offenders.map((f) => relative(AGENT_DIR, f))).toEqual([]);
	});
});
