import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, FlowBackend, OmniModel } from './config.js';
import { FlowCdpClient, type CdpGenerateResult } from './backends/flowCdp.js';
import {
  OmniApiClient,
  type OmniVideoResult,
  type VideoAspectRatio,
  type VideoResolution,
} from './backends/omniApi.js';
import { prepareAffiliatePack } from './storyboard.js';

export type StoryboardAttachmentMode = 'sheet' | 'split_frames';

export interface GeneratePackVideosParams {
  packDir: string;
  outputDir?: string;
  backend?: FlowBackend;
  model?: OmniModel;
  durationSeconds?: number;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  /** "sheet" sends STORYBOARD-SCENE-0X.jpg directly; "split_frames" sends cropped Panel 1 (start) + Panel 4 (end). Default: "sheet" */
  attachmentMode?: StoryboardAttachmentMode;
  /** Also attach PRODUCT-01, CHAR-A, LOC-01 as reference ingredients. Default: true */
  includeIngredients?: boolean;
  /** Specific scene numbers to generate (default: all discovered scenes, e.g. [1, 2, 3]) */
  scenes?: number[];
  /** Continue remaining scenes if one scene fails. Default: true */
  continueOnError?: boolean;
  /** Timeout per scene in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** For CDP backend: automatically open flow.google.com if tab not found */
  openFlowIfMissing?: boolean;
}

export interface BatchSceneResult {
  sceneNumber: number;
  status: 'completed' | 'submitted' | 'timeout' | 'failed';
  outputPath?: string;
  interactionId?: string;
  videoUri?: string;
  attachedFiles: string[];
  error?: string;
  raw?: OmniVideoResult | CdpGenerateResult;
}

export interface GeneratePackVideosResult {
  packDir: string;
  outputDir: string;
  batchResultPath: string;
  backend: FlowBackend;
  model: OmniModel;
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  attachmentMode: StoryboardAttachmentMode;
  totalRequested: number;
  succeeded: number;
  failed: number;
  scenes: BatchSceneResult[];
}

export interface BatchClients {
  omniClient: OmniApiClient;
  cdpClient: FlowCdpClient;
}

export async function generatePackVideos(
  params: GeneratePackVideosParams,
  config: AppConfig,
  clients?: BatchClients
): Promise<GeneratePackVideosResult> {
  const backend: FlowBackend = params.backend ?? config.defaultBackend;
  const model: OmniModel = params.model ?? 'gemini-omni-1.1-flash';
  const durationSeconds = params.durationSeconds ?? 10;
  const resolution: VideoResolution = params.resolution ?? '720p';
  const aspectRatio: VideoAspectRatio = params.aspectRatio ?? '9:16';
  const attachmentMode: StoryboardAttachmentMode =
    params.attachmentMode ?? 'sheet';
  const includeIngredients = params.includeIngredients ?? true;
  const continueOnError = params.continueOnError ?? true;
  const timeoutMs = params.timeoutMs ?? 300_000;

  const prepared = await prepareAffiliatePack(params.packDir);
  const videosOutDir = path.resolve(
    params.outputDir ?? path.join(prepared.packDir, 'videos')
  );
  fs.mkdirSync(videosOutDir, { recursive: true });

  const omniClient = clients?.omniClient ?? new OmniApiClient(config);
  const cdpClient = clients?.cdpClient ?? new FlowCdpClient(config);

  const selectedScenes =
    params.scenes && params.scenes.length > 0
      ? prepared.scenes.filter((s) => params.scenes!.includes(s.sceneNumber))
      : prepared.scenes;

  if (selectedScenes.length === 0) {
    throw new Error(
      `No matching scenes found in ${prepared.packDir} (requested: ${JSON.stringify(params.scenes)})`
    );
  }

  const results: BatchSceneResult[] = [];

  for (const scene of selectedScenes) {
    const sceneLabel = `scene_${String(scene.sceneNumber).padStart(2, '0')}`;
    const targetMp4 = path.join(videosOutDir, `${sceneLabel}.mp4`);

    const promptText =
      scene.promptFilePath && fs.existsSync(scene.promptFilePath)
        ? fs.readFileSync(scene.promptFilePath, 'utf8').trim()
        : `Generate a smooth ${durationSeconds}-second ${aspectRatio} commercial video following the attached storyboard for Scene ${scene.sceneNumber}. Render full-frame vertical video with no 2x2 grid or borders.`;

    const ingredients = includeIngredients ? scene.ingredients : [];
    const attachedFiles: string[] = [];

    try {
      if (backend === 'api') {
        if (attachmentMode === 'sheet') {
          attachedFiles.push(scene.storyboardPath, ...ingredients);
        } else {
          attachedFiles.push(
            scene.startFramePath,
            scene.endFramePath,
            ...ingredients
          );
        }

        const apiRes = await omniClient.generateVideo({
          prompt: promptText,
          model,
          durationSeconds,
          resolution,
          aspectRatio,
          storyboardSheetPath:
            attachmentMode === 'sheet' ? scene.storyboardPath : undefined,
          firstFramePath:
            attachmentMode === 'split_frames'
              ? scene.startFramePath
              : undefined,
          lastFramePath:
            attachmentMode === 'split_frames' ? scene.endFramePath : undefined,
          referenceImagePaths: ingredients,
          outputPath: targetMp4,
          timeoutMs,
        });

        results.push({
          sceneNumber: scene.sceneNumber,
          status: apiRes.outputPath ? 'completed' : 'failed',
          outputPath: apiRes.outputPath,
          interactionId: apiRes.interactionId,
          videoUri: apiRes.videoUri,
          attachedFiles,
          raw: apiRes,
          error: apiRes.outputPath
            ? undefined
            : 'Interaction completed without a downloadable video output.',
        });
      } else {
        if (attachmentMode === 'sheet') {
          attachedFiles.push(scene.storyboardPath, ...ingredients);
        } else {
          attachedFiles.push(
            scene.startFramePath,
            scene.endFramePath,
            ...ingredients
          );
        }

        const cdpRes = await cdpClient.generateVideo({
          prompt: promptText,
          storyboardSheetPath:
            attachmentMode === 'sheet' ? scene.storyboardPath : undefined,
          firstFramePath:
            attachmentMode === 'split_frames'
              ? scene.startFramePath
              : undefined,
          lastFramePath:
            attachmentMode === 'split_frames' ? scene.endFramePath : undefined,
          referenceImagePaths: ingredients,
          modelLabel: model,
          durationSeconds,
          aspectRatio,
          outputPath: targetMp4,
          waitForCompletion: true,
          timeoutMs,
          openFlowIfMissing: params.openFlowIfMissing ?? false,
        });

        results.push({
          sceneNumber: scene.sceneNumber,
          status: cdpRes.status,
          outputPath: cdpRes.outputPath,
          videoUri: cdpRes.videoSrc,
          attachedFiles: cdpRes.attachedFiles,
          raw: cdpRes,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        sceneNumber: scene.sceneNumber,
        status: 'failed',
        attachedFiles,
        error: msg,
      });
      if (!continueOnError) {
        break;
      }
    }
  }

  const succeeded = results.filter(
    (r) => r.status === 'completed' && Boolean(r.outputPath)
  ).length;
  const failed = results.length - succeeded;

  const batchResultPath = path.join(videosOutDir, 'batch_result.json');
  const summary: GeneratePackVideosResult = {
    packDir: prepared.packDir,
    outputDir: videosOutDir,
    batchResultPath,
    backend,
    model,
    durationSeconds,
    aspectRatio,
    resolution,
    attachmentMode,
    totalRequested: selectedScenes.length,
    succeeded,
    failed,
    scenes: results,
  };

  fs.writeFileSync(batchResultPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}
