import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BackendSchema,
  OmniModelSchema,
  loadConfig,
  type AppConfig,
} from './config.js';
import { FlowCdpClient } from './backends/flowCdp.js';
import { OmniApiClient } from './backends/omniApi.js';
import { generatePackVideos } from './batch.js';
import {
  prepareAffiliatePack,
  splitStoryboardSheet,
} from './storyboard.js';

function jsonText(data: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function createGoogleFlowMcpServer(config: AppConfig = loadConfig()): McpServer {
  const cdpClient = new FlowCdpClient(config);
  const omniClient = new OmniApiClient(config);

  const server = new McpServer({
    name: 'google-flow-mcp',
    version: '1.1.0',
  });

  // 1. flow_status
  server.tool(
    'flow_status',
    'Check Google Flow Web Chrome CDP connection status, open flow.google.com tabs, and Gemini Omni Flash API readiness.',
    {},
    async () => {
      const cdp = await cdpClient.checkStatus();
      return jsonText({
        defaultBackend: config.defaultBackend,
        outputDir: config.outputDir,
        cdp,
        omniApi: {
          configured: omniClient.hasApiKey(),
          defaultModel: config.omniDefaultModel,
          endpoint: `${config.omniApiBaseUrl}/v1beta/interactions`,
          note: 'Gemini Omni 1.1 / 1.2 Flash requires a paid Gemini API billing tier (Free Tier limit is 0).',
        },
      });
    }
  );

  // 2. flow_split_storyboard
  server.tool(
    'flow_split_storyboard',
    'Split a 9:16 2x2 Storyboard Sheet image into 4 clean panels (panel_1_start, panel_2, panel_3, panel_4_end), trimming top timecode bars and grid borders for Google Flow / Gemini Omni.',
    {
      imagePath: z.string().min(1).describe('Path to the 2x2 storyboard image file'),
      outputDir: z
        .string()
        .optional()
        .describe('Directory to save the 4 cropped panels (defaults to <outputDir>/cropped_<stem>)'),
      headerTrimRatio: z
        .number()
        .min(0)
        .max(0.3)
        .optional()
        .describe('Fraction of panel height to trim from top label bar (default 0.065)'),
      footerTrimRatio: z
        .number()
        .min(0)
        .max(0.2)
        .optional()
        .describe('Fraction of panel height to trim from bottom (default 0.01)'),
      borderTrimPx: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe('Border pixels to trim around each panel (default 6)'),
      format: z
        .enum(['jpg', 'png'])
        .optional()
        .describe('Output image format (default jpg)'),
      prefix: z.string().optional().describe('Optional filename prefix'),
    },
    async (args) => {
      const stem = path.basename(args.imagePath, path.extname(args.imagePath));
      const outDir =
        args.outputDir ?? path.join(config.outputDir, `cropped_${stem}`);
      const result = await splitStoryboardSheet(args.imagePath, outDir, {
        headerTrimRatio: args.headerTrimRatio,
        footerTrimRatio: args.footerTrimRatio,
        borderTrimPx: args.borderTrimPx,
        format: args.format,
        prefix: args.prefix,
      });
      return jsonText(result);
    }
  );

  // 3. flow_generate_video
  server.tool(
    'flow_generate_video',
    'Generate a single video via Google Flow Web (Chrome CDP using AI Pro/Ultra credits) or Gemini Omni 1.1 / 1.2 Flash Interactions API. Supports sending a Storyboard Sheet directly ("sheet") or auto-cropping into Start+End frames ("split_frames").',
    {
      prompt: z.string().min(1).describe('Video generation prompt'),
      backend: BackendSchema.optional().describe(
        'Backend to use: "cdp" (Google Flow Web via Chrome) or "api" (Gemini Omni Flash API). Defaults to FLOW_DEFAULT_BACKEND.'
      ),
      storyboardSheetPath: z
        .string()
        .optional()
        .describe('Optional 2x2 Storyboard Sheet image path'),
      attachmentMode: z
        .enum(['sheet', 'split_frames'])
        .optional()
        .describe(
          'How to send storyboardSheetPath: "sheet" attaches the full storyboard sheet directly (default), "split_frames" auto-crops Panel 1 (start) and Panel 4 (end).'
        ),
      firstFramePath: z
        .string()
        .optional()
        .describe('Optional start/first frame image path'),
      lastFramePath: z
        .string()
        .optional()
        .describe('Optional end/last frame image path'),
      referenceImagePaths: z
        .array(z.string().min(1))
        .max(6)
        .optional()
        .describe('Optional ingredient/reference image paths (up to 6 total images for Omni API)'),
      model: OmniModelSchema.optional().describe(
        'Omni model ID (gemini-omni-1.1-flash or gemini-omni-1.2-flash)'
      ),
      durationSeconds: z
        .number()
        .int()
        .min(3)
        .max(15)
        .optional()
        .describe('Video duration in seconds (default 10s; strictly 3-10s when using both first and last frames)'),
      resolution: z
        .enum(['360p', '720p', '1080p', '4k'])
        .optional()
        .describe('Output resolution for Omni API (default 720p)'),
      aspectRatio: z
        .enum(['9:16', '16:9'])
        .optional()
        .describe('Aspect ratio (default 9:16)'),
      outputPath: z
        .string()
        .optional()
        .describe('Destination .mp4 file path'),
      waitForCompletion: z
        .boolean()
        .optional()
        .describe('For CDP backend: wait for new <video> and auto-download (default true when outputPath is given, else false)'),
      timeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(900000)
        .optional()
        .describe('Timeout in ms while waiting for video completion'),
      openFlowIfMissing: z
        .boolean()
        .optional()
        .describe('For CDP backend: open https://flow.google.com/ automatically if no tab is found'),
    },
    async (args) => {
      const backend = args.backend ?? config.defaultBackend;
      const mode = args.attachmentMode ?? 'sheet';
      const model = args.model ?? config.omniDefaultModel;
      const durationSeconds = args.durationSeconds ?? 10;
      const aspectRatio = args.aspectRatio ?? '9:16';

      let directSheetPath: string | undefined;
      let firstFramePath = args.firstFramePath;
      let lastFramePath = args.lastFramePath;
      let splitSummary: unknown;

      if (args.storyboardSheetPath) {
        if (mode === 'split_frames') {
          const stem = path.basename(
            args.storyboardSheetPath,
            path.extname(args.storyboardSheetPath)
          );
          const splitDir = path.join(config.outputDir, `split_${stem}_${Date.now()}`);
          const split = await splitStoryboardSheet(args.storyboardSheetPath, splitDir);
          firstFramePath = firstFramePath ?? split.startFramePath;
          lastFramePath = lastFramePath ?? split.endFramePath;
          splitSummary = {
            mode: 'split_frames',
            sourcePath: split.sourcePath,
            startFramePath: split.startFramePath,
            endFramePath: split.endFramePath,
          };
        } else {
          directSheetPath = args.storyboardSheetPath;
        }
      }

      if (backend === 'api') {
        const result = await omniClient.generateVideo({
          prompt: args.prompt,
          model,
          durationSeconds,
          resolution: args.resolution,
          aspectRatio,
          storyboardSheetPath: directSheetPath,
          firstFramePath,
          lastFramePath,
          referenceImagePaths: args.referenceImagePaths,
          outputPath: args.outputPath,
          timeoutMs: args.timeoutMs,
        });
        return jsonText({ backend: 'api', attachmentMode: mode, splitSummary, result });
      }

      const result = await cdpClient.generateVideo({
        prompt: args.prompt,
        storyboardSheetPath: directSheetPath,
        firstFramePath,
        lastFramePath,
        referenceImagePaths: args.referenceImagePaths,
        modelLabel: model,
        durationSeconds,
        aspectRatio,
        outputPath: args.outputPath,
        waitForCompletion: args.waitForCompletion ?? Boolean(args.outputPath),
        timeoutMs: args.timeoutMs,
        openFlowIfMissing: args.openFlowIfMissing ?? false,
      });
      return jsonText({ backend: 'cdp', attachmentMode: mode, splitSummary, result });
    }
  );

  // 4. flow_generate_pack_videos (1-click 3-scene batch generator + downloader)
  server.tool(
    'flow_generate_pack_videos',
    'Batch-generate all 3 scenes (10s each = 30s) from a storyboard pack directory using Gemini Omni 1.1 / 1.2 Flash (via Chrome CDP or Official Interactions API) and automatically download scene_01.mp4, scene_02.mp4, scene_03.mp4.',
    {
      packDir: z
        .string()
        .min(1)
        .describe('Directory containing STORYBOARD-SCENE-01/02/03.jpg and *_MASTER_PROMPT.md'),
      outputDir: z
        .string()
        .optional()
        .describe('Destination folder for scene_01..03.mp4 (defaults to <packDir>/videos)'),
      backend: BackendSchema.optional().describe(
        '"cdp" (Google Flow Web Chrome) or "api" (Gemini Omni Flash API). Defaults to FLOW_DEFAULT_BACKEND.'
      ),
      model: OmniModelSchema.optional().describe(
        'Target model ID (default: gemini-omni-1.1-flash)'
      ),
      durationSeconds: z
        .number()
        .int()
        .min(3)
        .max(15)
        .optional()
        .describe('Seconds per scene (default: 10)'),
      resolution: z
        .enum(['360p', '720p', '1080p', '4k'])
        .optional()
        .describe('Output resolution for API mode (default: 720p)'),
      aspectRatio: z
        .enum(['9:16', '16:9'])
        .optional()
        .describe('Aspect ratio (default: 9:16)'),
      attachmentMode: z
        .enum(['sheet', 'split_frames'])
        .optional()
        .describe('"sheet" sends STORYBOARD-SCENE-0X.jpg directly (default); "split_frames" sends cropped Start+End frames'),
      includeIngredients: z
        .boolean()
        .optional()
        .describe('Attach PRODUCT-01, CHAR-A, LOC-01 alongside each scene storyboard (default: true)'),
      scenes: z
        .array(z.number().int().min(1))
        .optional()
        .describe('Optional subset of scene numbers, e.g. [1, 2, 3]'),
      continueOnError: z
        .boolean()
        .optional()
        .describe('Continue remaining scenes if one scene fails (default: true)'),
      timeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(900000)
        .optional()
        .describe('Timeout per scene in ms (default: 300000)'),
      openFlowIfMissing: z.boolean().optional(),
    },
    async (args) => {
      const result = await generatePackVideos(
        {
          packDir: args.packDir,
          outputDir: args.outputDir,
          backend: args.backend,
          model: args.model ?? 'gemini-omni-1.1-flash',
          durationSeconds: args.durationSeconds ?? 10,
          resolution: args.resolution ?? '720p',
          aspectRatio: args.aspectRatio ?? '9:16',
          attachmentMode: args.attachmentMode ?? 'sheet',
          includeIngredients: args.includeIngredients ?? true,
          scenes: args.scenes,
          continueOnError: args.continueOnError ?? true,
          timeoutMs: args.timeoutMs,
          openFlowIfMissing: args.openFlowIfMissing,
        },
        config,
        { omniClient, cdpClient }
      );
      return jsonText(result);
    }
  );

  // 5. flow_edit_or_extend_video
  server.tool(
    'flow_edit_or_extend_video',
    'Conversationally edit or extend a previously generated Gemini Omni Flash video using its interactionId (3-10s per turn, up to 30s total).',
    {
      previousInteractionId: z
        .string()
        .min(1)
        .describe('interactionId returned by an earlier flow_generate_video (api backend) call'),
      prompt: z
        .string()
        .min(1)
        .describe('Edit or continuation instruction'),
      model: OmniModelSchema.optional(),
      durationSeconds: z
        .number()
        .int()
        .min(3)
        .max(10)
        .optional()
        .describe('Duration for the edit/extension turn (3-10s, default 5s)'),
      resolution: z.enum(['360p', '720p', '1080p', '4k']).optional(),
      aspectRatio: z.enum(['9:16', '16:9']).optional(),
      referenceImagePaths: z.array(z.string().min(1)).max(6).optional(),
      outputPath: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(900000).optional(),
    },
    async (args) => {
      const result = await omniClient.editOrExtendVideo({
        previousInteractionId: args.previousInteractionId,
        prompt: args.prompt,
        model: args.model,
        durationSeconds: args.durationSeconds,
        resolution: args.resolution,
        aspectRatio: args.aspectRatio,
        referenceImagePaths: args.referenceImagePaths,
        outputPath: args.outputPath,
        timeoutMs: args.timeoutMs,
      });
      return jsonText({ backend: 'api', result });
    }
  );

  // 6. flow_prepare_affiliate_pack
  server.tool(
    'flow_prepare_affiliate_pack',
    'Prepare a motion-infographic-affiliate output folder for Google Flow: splits STORYBOARD-SCENE-01/02/03 into cropped Start/End frames, extracts per-scene prompts from *_MASTER_PROMPT.md, and writes flow_ready/manifest.json.',
    {
      packDir: z
        .string()
        .min(1)
        .describe('Directory containing STORYBOARD-SCENE-01/02/03.* and *_MASTER_PROMPT.md'),
      outputDir: z
        .string()
        .optional()
        .describe('Destination directory (defaults to <packDir>/flow_ready)'),
      headerTrimRatio: z.number().min(0).max(0.3).optional(),
      borderTrimPx: z.number().int().min(0).max(60).optional(),
      format: z.enum(['jpg', 'png']).optional(),
    },
    async (args) => {
      const result = await prepareAffiliatePack(args.packDir, args.outputDir, {
        headerTrimRatio: args.headerTrimRatio,
        borderTrimPx: args.borderTrimPx,
        format: args.format,
      });
      return jsonText(result);
    }
  );

  // 7. flow_screenshot
  server.tool(
    'flow_screenshot',
    'Capture a screenshot of the active Google Flow Web tab connected over Chrome CDP.',
    {
      outputPath: z.string().optional().describe('Destination PNG file path'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page (default false)'),
    },
    async (args) => {
      const result = await cdpClient.takeScreenshot(
        args.outputPath,
        args.fullPage ?? false
      );
      return jsonText(result);
    }
  );

  // 8. flow_inspect_dom
  server.tool(
    'flow_inspect_dom',
    'Inspect interactive DOM elements (textareas, buttons, file inputs, videos) on the active flow.google.com tab to calibrate selectors.json.',
    {
      maxElements: z
        .number()
        .int()
        .min(5)
        .max(200)
        .optional()
        .describe('Maximum DOM nodes to return (default 60)'),
    },
    async (args) => {
      const result = await cdpClient.inspectDom(args.maxElements ?? 60);
      return jsonText(result);
    }
  );

  return server;
}
