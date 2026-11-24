#!/usr/bin/env node
import { loadConfig, type FlowBackend, type OmniModel } from './config.js';
import {
  generatePackVideos,
  type StoryboardAttachmentMode,
} from './batch.js';
import type { VideoAspectRatio, VideoResolution } from './backends/omniApi.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const packDir = getArg('--pack');
  if (!packDir || hasFlag('--help') || hasFlag('-h')) {
    console.log(`Usage:
  npm run batch -- --pack <packDir> [options]

Options:
  --pack <dir>           Directory containing STORYBOARD-SCENE-01..03.jpg & *_MASTER_PROMPT.md
  --out <dir>            Output directory for downloaded scene_01..03.mp4 (default: <pack>/videos)
  --backend <cdp|api>    cdp (Google Flow Web Chrome) or api (Gemini Omni Flash API)
  --model <id>           gemini-omni-1.1-flash (default) | gemini-omni-1.2-flash
  --duration <seconds>   Seconds per scene (default: 10)
  --ratio <9:16|16:9>    Aspect ratio (default: 9:16)
  --res <360p|720p|1080p|4k>  Resolution for API mode (default: 720p)
  --mode <sheet|split_frames> Send whole storyboard sheet (default) or cropped start+end frames
  --no-ingredients       Do not attach PRODUCT-01 / CHAR-A / LOC-01
  --scenes <1,2,3>       Comma-separated scene numbers to run
`);
    process.exit(packDir ? 0 : 1);
  }

  const config = loadConfig();
  const backend = (getArg('--backend') as FlowBackend | undefined) ?? config.defaultBackend;
  const model = (getArg('--model') as OmniModel | undefined) ?? 'gemini-omni-1.1-flash';
  const durationSeconds = Number(getArg('--duration') ?? '10');
  const aspectRatio = (getArg('--ratio') as VideoAspectRatio | undefined) ?? '9:16';
  const resolution = (getArg('--res') as VideoResolution | undefined) ?? '720p';
  const attachmentMode =
    (getArg('--mode') as StoryboardAttachmentMode | undefined) ?? 'sheet';
  const scenesArg = getArg('--scenes');
  const scenes = scenesArg
    ? scenesArg
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n))
    : undefined;

  console.error(
    `[google-flow-batch] Starting batch: pack=${packDir}, backend=${backend}, model=${model}, duration=${durationSeconds}s, mode=${attachmentMode}`
  );

  const summary = await generatePackVideos(
    {
      packDir,
      outputDir: getArg('--out'),
      backend,
      model,
      durationSeconds,
      aspectRatio,
      resolution,
      attachmentMode,
      includeIngredients: !hasFlag('--no-ingredients'),
      scenes,
    },
    config
  );

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0 && summary.succeeded === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[google-flow-batch] Error:', err);
  process.exit(1);
});
