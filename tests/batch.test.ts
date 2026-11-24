import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FlowCdpClient } from '../src/backends/flowCdp.js';
import { OmniApiClient } from '../src/backends/omniApi.js';
import { generatePackVideos } from '../src/batch.js';

async function createImg(filePath: string): Promise<void> {
  const img = new Jimp({ width: 200, height: 400, color: 0xffffffff });
  await img.write(filePath as `${string}.${string}`);
}

describe('generatePackVideos (3-scene Storyboard Sheet -> Omni 1.1 Flash -> download)', () => {
  it('sends all 3 storyboard sheets at 10s with gemini-omni-1.1-flash and downloads scene_01..03.mp4', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-batch-'));
    try {
      await createImg(path.join(tmpDir, 'STORYBOARD-SCENE-01.jpg'));
      await createImg(path.join(tmpDir, 'STORYBOARD-SCENE-02.jpg'));
      await createImg(path.join(tmpDir, 'STORYBOARD-SCENE-03.jpg'));
      await createImg(path.join(tmpDir, 'PRODUCT-01.jpg'));
      fs.writeFileSync(
        path.join(tmpDir, 'DEMO_NO_VIDEO_MASTER_PROMPT.md'),
        [
          'PHASE C: STORY-TO-VIDEO',
          '--- SCENE 1 (Hook) ---',
          'Scene 1 action',
          '--- SCENE 2 (Feature) ---',
          'Scene 2 action',
          '--- SCENE 3 (CTA) ---',
          'Scene 3 action',
          'PHASE D: END',
        ].join('\n'),
        'utf8'
      );

      let createCallCount = 0;
      const seenModels: string[] = [];
      const seenDurations: string[] = [];

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/upload/v1beta/files')) {
          return new Response('', {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://upload.test/part' },
          });
        }
        if (url === 'https://upload.test/part') {
          return new Response(
            JSON.stringify({
              file: {
                name: 'files/sb-img',
                uri: 'https://generativelanguage.googleapis.com/v1beta/files/sb-img',
                mimeType: 'image/jpeg',
                state: 'ACTIVE',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/v1beta/interactions') && init?.method === 'POST') {
          createCallCount += 1;
          const body = JSON.parse(String(init.body)) as {
            model: string;
            response_format: { duration: string };
          };
          seenModels.push(body.model);
          seenDurations.push(body.response_format.duration);
          // Also verify steps[].content[] response parsing!
          return new Response(
            JSON.stringify({
              id: `inter_scene_${createCallCount}`,
              status: 'completed',
              steps: [
                {
                  content: [
                    {
                      type: 'video',
                      uri: `https://generativelanguage.googleapis.com/v1beta/files/vid_${createCallCount}`,
                      mime_type: 'video/mp4',
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/v1beta/files/vid_')) {
          return new Response(Buffer.from(`MP4_DATA_${url}`), {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = loadConfig({
        FLOW_DEFAULT_BACKEND: 'api',
        GOOGLE_API_KEY: 'test-key',
        OMNI_DEFAULT_MODEL: 'gemini-omni-1.1-flash',
      });

      const summary = await generatePackVideos(
        {
          packDir: tmpDir,
          backend: 'api',
          model: 'gemini-omni-1.1-flash',
          durationSeconds: 10,
          aspectRatio: '9:16',
          attachmentMode: 'sheet',
        },
        cfg,
        {
          omniClient: new OmniApiClient(cfg, mockFetch),
          cdpClient: new FlowCdpClient(cfg),
        }
      );

      expect(summary.totalRequested).toBe(3);
      expect(summary.succeeded).toBe(3);
      expect(summary.failed).toBe(0);
      expect(seenModels).toEqual([
        'gemini-omni-1.1-flash',
        'gemini-omni-1.1-flash',
        'gemini-omni-1.1-flash',
      ]);
      expect(seenDurations).toEqual(['10s', '10s', '10s']);
      expect(fs.existsSync(summary.batchResultPath)).toBe(true);

      for (const s of summary.scenes) {
        expect(s.status).toBe('completed');
        expect(s.outputPath).toBeDefined();
        expect(fs.existsSync(s.outputPath!)).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
