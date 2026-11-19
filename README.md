# Private AI Chat for Obsidian

Your most sensitive notes, your private thoughts — other AI plugins send them to someone's servers. Private AI doesn't.

* ✅ Your notes stay on your device
* ✅ Use local LLMs like gpt-oss, Qwen3, Gemma4, DeepSeek, Mistral and many more, locally on your own hardware
* ✅ No data is transmitted to external services
* ✅ No analytics or tracking

Compatible With: [LM Studio](https://lmstudio.ai/)

## Getting Started + Setup

* Goto Community Plugins
* Search `Private AI` and click Install
* Click Enable

Enjoy!

## Features

- **Easy Setup**: Easy setup and model swapping with LM Studio
- **Cross Platform**: Supports for most modern Mac and Windows machines
- **Agent that works your vault**: The AI searches, reads and (when you ask) creates, edits, moves or deletes notes itself, then cites the notes it used. It runs on the open-source [Pi](https://github.com/badlogic/pi-mono) agent harness.
- **No embeddings, no index database**: Notes are found with BM25 ranked search plus grep over the files on disk, so there's no embedding model to load and nothing to rebuild. Text in images can be read once by a vision model and searched too.
- **Built-in MCP server**: The vault tools live in an MCP server inside the plugin. The chat uses it directly, and you can optionally share it on `127.0.0.1` (token protected) with other MCP clients such as LM Studio or Claude Desktop.
- **Open Tab Context**: Focus your conversation on specific notes for focused insights
- **Performance Tuning**: Customize models, search parameters, token limits, and more to tune performance for your hardware

![Easy and powerful configuration](img/config.png)

## Example Queries

- "I have to have a difficult conversation with a friend, read my journal entry about the situation and help me come up with a good way to talk to my friend compassionately"
- "My partner was a jerk to me, help me look at other alternative reasons why they may have reacted the way they did"
- "Talk to this journal entry like a good friend"
- "When did I first meet Jacob?"
- "What did frank talk about at our meeting on Obsidian plugins?"
- "What did I write about machine learning?"
- "What are my thoughts on productivity systems?"
- "Make a note in Projects called Garden with a checklist for spring planting"
- "Move my 2023 trip notes into Archive/Travel"

## How it works

```
Chat view ──► Pi agent loop (pi-agent-core + pi-ai, OpenAI-compatible) ──► LM Studio
                  │
                  ▼  tool calls over MCP (in-process)
          Built-in MCP server ──► vault tools ──► BM25 index + grep over your notes
                  ▲
                  └── optional: http://127.0.0.1:22360/mcp for other MCP clients
```

Pick a model with good native tool use (Qwen 3, Gemma 4, gpt-oss) for the best results.

## Development

### Tests

- `npm test` runs the unit and integration tests (Vitest). The agent stack under `src/agent/` has no Obsidian dependency, so the agent loop, MCP server, tools and search are tested in plain Node against an in-memory vault and a scripted model, plus a fake OpenAI-compatible server.
- `npm run eval` boots real Obsidian with the test vault via wdio-obsidian-service (see `AGENTIC_HARNESS_PLAN.md`).

### Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Attributions

This project respects and is compatible with the original licenses of all code and dependencies used:

### Development Tools
- **[esbuild](https://esbuild.github.io/)** - MIT License - Used for bundling the plugin
- **[TypeScript](https://www.typescriptlang.org/)** - Apache-2.0 License - Used for type safety
- **[Obsidian API](https://github.com/obsidianmd/obsidian-api)** - MIT License - Official Obsidian plugin API

### Runtime libraries
- **[Pi](https://github.com/badlogic/pi-mono)** (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`) - MIT License - Agent loop and LLM client
- **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)** - MIT License - Built-in MCP server
- **[TypeBox](https://github.com/sinclairzx81/typebox)** - MIT License - Tool schemas

### Dependencies
All development dependencies are used under their respective open-source licenses (MIT, Apache-2.0, ISC, BSD) and are properly externalized in the build process.

### Third-Party Services
This plugin integrates with local LLM services but does not include any of their code:
- **[LM Studio](https://lmstudio.ai/)** - Proprietary - Local LLM interface

### License

This project is licensed under the [MIT License](LICENSE.md).
