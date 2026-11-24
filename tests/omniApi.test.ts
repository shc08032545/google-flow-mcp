import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { OmniApiClient } from '../src/backends/omniApi.js';

describe('OmniApiClient (Gemini Omni 1.1 / 1.2 Flash Interactions API)', () => {
  it('enforces 3-10s limit when both firstFramePath and lastFramePath are provided', () => {
    const cfg = loadConfig({ GOOGLE_API_KEY: 'dummy-key' });
    const client = new OmniApiClient(cfg);

    expect(() =>
      client.validateGenerateParams({
        prompt: 'test',
        durationSeconds: 12,
        firstFramePath: '/tmp/a.jpg',
        lastFramePath: '/tmp/b.jpg',
      })
    ).toThrow(/3 and 10 seconds/);

    expect(() =>
      client.validateGenerateParams({
        prompt: 'test',
        durationSeconds: 15,
        firstFramePath: '/tmp/a.jpg',
      })
    ).not.toThrow();
  });

  it('enforces maximum of 6 total input images', () => {
    const cfg = loadConfig({ GOOGLE_API_KEY: 'dummy-key' });
    const client = new OmniApiClient(cfg);

    expect(() =>
      client.validateGenerateParams({
        prompt: 'test',
        firstFramePath: '/tmp/1.jpg',
        lastFramePath: '/tmp/2.jpg',
        referenceImagePaths: [
          '/tmp/3.jpg',
          '/tmp/4.jpg',
          '/tmp/5.jpg',
          '/tmp/6.jpg',
          '/tmp/7.jpg',
        ],
      })
    ).toThrow(/up to 6 images/);
  });

  it('uploads media via Files API, creates interaction, polls, and downloads mp4', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-omni-'));
    try {
      const startFrame = path.join(tmpDir, 'start.jpg');
      const endFrame = path.join(tmpDir, 'end.jpg');
      const outVideo = path.join(tmpDir, 'scene_01.mp4');
      fs.writeFileSync(startFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      fs.writeFileSync(endFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

      let interactionPayload: Record<string, unknown> | undefined;
      let pollCount = 0;

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/upload/v1beta/files')) {
          return new Response('', {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://upload.example.test/session-1' },
          });
        }

        if (url === 'https://upload.example.test/session-1') {
          return new Response(
            JSON.stringify({
              file: {
                name: 'files/mock-img',
                uri: 'https://generativelanguage.googleapis.com/v1beta/files/mock-img',
                mimeType: 'image/jpeg',
                state: 'ACTIVE',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.endsWith('/v1beta/interactions') && init?.method === 'POST') {
          interactionPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              id: 'inter_abc123',
              status: 'in_progress',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.endsWith('/v1beta/interactions/inter_abc123')) {
          pollCount += 1;
          return new Response(
            JSON.stringify({
              id: 'inter_abc123',
              status: 'completed',
              outputs: [
                {
                  type: 'video',
                  uri: 'https://download.example.test/video.mp4',
                  mime_type: 'video/mp4',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url === 'https://download.example.test/video.mp4') {
          return new Response(Buffer.from('FAKE_MP4_BYTES'), {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
          });
        }

        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = loadConfig({
        GOOGLE_API_KEY: 'secret-test-key',
        FLOW_OUTPUT_DIR: tmpDir,
      });
      const client = new OmniApiClient(cfg, mockFetch);

      const res = await client.generateVideo({
        prompt: 'Smooth commercial push-in on white sandals',
        firstFramePath: startFrame,
        lastFramePath: endFrame,
        durationSeconds: 10,
        resolution: '720p',
        aspectRatio: '9:16',
        outputPath: outVideo,
        pollIntervalMs: 10,
      });

      expect(res.interactionId).toBe('inter_abc123');
      expect(res.status).toBe('completed');
      expect(res.outputPath).toBe(outVideo);
      expect(pollCount).toBe(1);
      expect(fs.readFileSync(outVideo, 'utf8')).toBe('FAKE_MP4_BYTES');

      expect(interactionPayload).toBeDefined();
      expect(interactionPayload?.model).toBe('gemini-omni-1.2-flash');
      expect(interactionPayload?.store).toBe(true);
      expect(interactionPayload?.response_format).toEqual({
        type: 'video',
        delivery: 'uri',
        duration: '10s',
        resolution: '720p',
        aspect_ratio: '9:16',
      });
      // Confirm unsupported parameters are NOT sent
      expect(interactionPayload).not.toHaveProperty('temperature');
      expect(interactionPayload).not.toHaveProperty('top_p');
      expect(interactionPayload).not.toHaveProperty('system_instruction');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sends previous_interaction_id for editOrExtendVideo', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-ext-'));
    try {
      let sentBody: Record<string, unknown> | undefined;
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1beta/interactions')) {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              id: 'inter_ext_2',
              status: 'completed',
              outputs: [
                {
                  type: 'video',
                  data: Buffer.from('EXTENDED_MP4').toString('base64'),
                  mime_type: 'video/mp4',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = loadConfig({
        GOOGLE_API_KEY: 'secret-test-key',
        FLOW_OUTPUT_DIR: tmpDir,
      });
      const client = new OmniApiClient(cfg, mockFetch);

      const res = await client.editOrExtendVideo({
        previousInteractionId: 'inter_abc123',
        prompt: 'Extend 5 seconds with gentle orbit right',
        durationSeconds: 5,
      });

      expect(sentBody?.previous_interaction_id).toBe('inter_abc123');
      expect(res.interactionId).toBe('inter_ext_2');
      expect(res.outputPath).toBeDefined();
      expect(fs.readFileSync(res.outputPath!, 'utf8')).toBe('EXTENDED_MP4');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
