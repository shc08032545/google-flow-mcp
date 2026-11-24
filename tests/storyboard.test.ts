import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  extractScenePrompts,
  prepareAffiliatePack,
  splitStoryboardSheet,
} from '../src/storyboard.js';

async function createSyntheticStoryboard(filePath: string): Promise<void> {
  // 400x800 synthetic 2x2 grid image (each quadrant 200x400)
  const img = new Jimp({ width: 400, height: 800, color: 0xffffffff });
  await img.write(filePath as `${string}.${string}`);
}

describe('storyboard splitter & affiliate pack helper', () => {
  it('splits a 2x2 storyboard sheet into 4 clean cropped panels', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-sb-'));
    try {
      const src = path.join(tmpDir, 'STORYBOARD-SCENE-01.jpg');
      const outDir = path.join(tmpDir, 'out');
      await createSyntheticStoryboard(src);

      const result = await splitStoryboardSheet(src, outDir, {
        headerTrimRatio: 0.05,
        footerTrimRatio: 0.0,
        borderTrimPx: 4,
      });

      expect(result.sourceWidth).toBe(400);
      expect(result.sourceHeight).toBe(800);
      expect(result.panels).toHaveLength(4);
      expect(fs.existsSync(result.startFramePath)).toBe(true);
      expect(fs.existsSync(result.endFramePath)).toBe(true);

      // Each panel: width = 200 - 8 = 192, height = 400 - 8 - 20 = 372
      for (const panel of result.panels) {
        expect(fs.existsSync(panel.filePath)).toBe(true);
        expect(panel.width).toBe(192);
        expect(panel.height).toBe(372);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts Phase C per-scene prompts from Master Prompt markdown', () => {
    const sampleMd = `
# Sample Pack
====================================================================
PHASE B: STORYBOARD
====================================================================
[STORYBOARD 1 — STORYBOARD-SCENE-01]
Some storyboard text

====================================================================
PHASE C: STORY-TO-VIDEO (NO VIDEO — 3 SCENES × 10s = 30s)
====================================================================

--- SCENE 1 (Global 00:00–00:10 | Hook & Reveal) ---
[SHOT LIST]
Scene one body text here.

--- SCENE 2 (Global 00:10–00:20 | Feature Demonstration) ---
[SHOT LIST]
Scene two body text here.

--- SCENE 3 (Global 00:20–00:30 | Product Hero + CTA) ---
[SHOT LIST]
Scene three body text here.

====================================================================
PHASE D: KEYWORD TABLE
====================================================================
`;

    const scenes = extractScenePrompts(sampleMd);
    expect(scenes).toHaveLength(3);
    expect(scenes[0].sceneNumber).toBe(1);
    expect(scenes[0].prompt).toContain('Scene one body text here.');
    expect(scenes[1].sceneNumber).toBe(2);
    expect(scenes[1].prompt).toContain('Scene two body text here.');
    expect(scenes[2].sceneNumber).toBe(3);
    expect(scenes[2].prompt).toContain('Scene three body text here.');
  });

  it('prepares a full affiliate pack into flow_ready/ with manifest and prompts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-pack-'));
    try {
      await createSyntheticStoryboard(path.join(tmpDir, 'STORYBOARD-SCENE-01.jpg'));
      await createSyntheticStoryboard(path.join(tmpDir, 'STORYBOARD-SCENE-02.jpg'));
      await createSyntheticStoryboard(path.join(tmpDir, 'PRODUCT-01.jpg'));
      await createSyntheticStoryboard(path.join(tmpDir, 'CHAR-A.jpg'));

      fs.writeFileSync(
        path.join(tmpDir, 'TEST_NO_VIDEO_MASTER_PROMPT.md'),
        `PHASE C: STORY-TO-VIDEO\n--- SCENE 1 (Hook) ---\nPrompt 1\n--- SCENE 2 (Demo) ---\nPrompt 2\nPHASE D: END\n`,
        'utf8'
      );

      const prepared = await prepareAffiliatePack(tmpDir);
      expect(prepared.scenes).toHaveLength(2);
      expect(prepared.ingredients).toHaveLength(2);
      expect(fs.existsSync(prepared.manifestPath)).toBe(true);
      expect(prepared.scenes[0].promptFilePath).toBeDefined();
      expect(fs.existsSync(prepared.scenes[0].promptFilePath!)).toBe(true);
      expect(fs.existsSync(prepared.scenes[0].startFramePath)).toBe(true);
      expect(fs.existsSync(prepared.scenes[0].endFramePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
