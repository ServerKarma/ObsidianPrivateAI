# PR demo recordings

Recordings of open pull requests working in the real plugin in real Obsidian (1.15.1),
captured under Xvfb with ffmpeg. Every click and key press goes to the real plugin; the
purple caption bar and the white pointer are overlays added so the viewer can follow.

The model server is a scripted stand-in (`kit/fakeServer.ts`): the model's words are
scripted, while the plugin's tools (search, tags, reading notes) run for real on the demo
vault in `e2e/vault`. No real LM Studio or Ollama was used.

To re-record one, copy `kit/*` into `e2e/demo/` on that PR's branch, `npm ci && npm run build`, then:

    DEMO=pr76 xvfb-run -a -s "-screen 0 1280x800x24" npx wdio run e2e/demo/wdio.demo.conf.mts

The GIF and MP4 land in `demo-out/`.
