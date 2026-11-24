import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, OmniModel } from '../config.js';

export type VideoResolution = '360p' | '720p' | '1080p' | '4k';
export type VideoAspectRatio = '9:16' | '16:9';

export interface OmniGenerateParams {
  prompt: string;
  model?: OmniModel;
  durationSeconds?: number;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  firstFramePath?: string;
  lastFramePath?: string;
  referenceImagePaths?: string[];
  outputPath?: string;
  store?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface OmniEditOrExtendParams {
  previousInteractionId: string;
  prompt: string;
  model?: OmniModel;
  durationSeconds?: number;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  referenceImagePaths?: string[];
  outputPath?: string;
  store?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface OmniVideoResult {
  interactionId: string;
  model: string;
  status: string;
  outputPath?: string;
  videoUri?: string;
  mimeType?: string;
  durationSeconds: number;
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
  rawOutputs?: unknown[];
}

interface UploadedFileRef {
  name: string;
  uri: string;
  mimeType: string;
}

type FetchLike = typeof fetch;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OmniApiClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: OmniModel;
  private readonly outputDir: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: AppConfig, fetchImpl: FetchLike = fetch) {
    this.apiKey = config.googleApiKey;
    this.baseUrl = config.omniApiBaseUrl;
    this.defaultModel = config.omniDefaultModel;
    this.outputDir = config.outputDir;
    this.fetchImpl = fetchImpl;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error(
        'GOOGLE_API_KEY (or GEMINI_API_KEY) is not configured. Set it in .env or MCP client env to use the Gemini Omni Flash API backend (paid Gemini API tier required).'
      );
    }
    return this.apiKey;
  }

  /**
   * Uploads a local image or video using the Gemini Files API resumable upload
   * protocol and polls until state === "ACTIVE".
   */
  async uploadFile(filePath: string): Promise<UploadedFileRef> {
    const apiKey = this.requireApiKey();
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Media file not found: ${resolved}`);
    }

    const bytes = fs.readFileSync(resolved);
    const mimeType = inferMimeType(resolved);
    const displayName = path.basename(resolved);

    // Step 1: Start resumable upload session
    const startRes = await this.fetchImpl(
      `${this.baseUrl}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
      }
    );

    if (!startRes.ok) {
      const errText = await startRes.text();
      throw new Error(
        `Gemini Files API start upload failed (${startRes.status}): ${errText}`
      );
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error(
        'Gemini Files API did not return x-goog-upload-url header.'
      );
    }

    // Step 2: Upload bytes and finalize
    const uploadRes = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(bytes.byteLength),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: bytes,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(
        `Gemini Files API upload bytes failed (${uploadRes.status}): ${errText}`
      );
    }

    const uploadJson = (await uploadRes.json()) as {
      file?: { name?: string; uri?: string; mimeType?: string; state?: string };
      name?: string;
      uri?: string;
      mimeType?: string;
      state?: string;
    };

    const fileObj = uploadJson.file ?? uploadJson;
    if (!fileObj.name || !fileObj.uri) {
      throw new Error(
        `Unexpected Gemini Files API response: ${JSON.stringify(uploadJson)}`
      );
    }

    // Step 3: Poll until file is ACTIVE (important for larger media)
    let state = fileObj.state ?? 'ACTIVE';
    const deadline = Date.now() + 60_000;
    while (state === 'PROCESSING' && Date.now() < deadline) {
      await sleep(1500);
      const statusRes = await this.fetchImpl(
        `${this.baseUrl}/v1beta/${fileObj.name}`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
        }
      );
      if (statusRes.ok) {
        const statusJson = (await statusRes.json()) as { state?: string };
        state = statusJson.state ?? 'ACTIVE';
      }
    }

    if (state === 'FAILED') {
      throw new Error(`Gemini Files API processing failed for ${displayName}`);
    }

    return {
      name: fileObj.name,
      uri: fileObj.uri,
      mimeType: fileObj.mimeType ?? mimeType,
    };
  }

  validateGenerateParams(params: OmniGenerateParams): {
    durationSeconds: number;
    resolution: VideoResolution;
    aspectRatio: VideoAspectRatio;
    model: OmniModel;
  } {
    const model = params.model ?? this.defaultModel;
    const durationSeconds = params.durationSeconds ?? 10;
    const resolution = params.resolution ?? '720p';
    const aspectRatio = params.aspectRatio ?? '9:16';

    const hasBothFrames = Boolean(params.firstFramePath && params.lastFramePath);
    const maxDuration = hasBothFrames ? 10 : 15;

    if (durationSeconds < 3 || durationSeconds > maxDuration) {
      throw new Error(
        hasBothFrames
          ? `Invalid durationSeconds=${durationSeconds}. When both firstFramePath and lastFramePath are provided, Gemini Omni Flash requires duration between 3 and 10 seconds.`
          : `Invalid durationSeconds=${durationSeconds}. Gemini Omni Flash requires duration between 3 and 15 seconds.`
      );
    }

    const totalImages =
      (params.firstFramePath ? 1 : 0) +
      (params.lastFramePath ? 1 : 0) +
      (params.referenceImagePaths?.length ?? 0);

    if (totalImages > 6) {
      throw new Error(
        `Too many input images (${totalImages}). Gemini Omni Flash supports up to 6 images per interaction.`
      );
    }

    return { durationSeconds, resolution, aspectRatio, model };
  }

  async generateVideo(params: OmniGenerateParams): Promise<OmniVideoResult> {
    const validated = this.validateGenerateParams(params);
    const inputItems: Array<Record<string, unknown>> = [];

    // Build structured prompt cues so Omni understands frame roles cleanly
    const promptLines: string[] = [params.prompt.trim()];

    if (params.firstFramePath) {
      const uploaded = await this.uploadFile(params.firstFramePath);
      inputItems.push({
        type: 'image',
        uri: uploaded.uri,
        mime_type: uploaded.mimeType,
      });
      promptLines.push(
        'Use the first attached image strictly as the opening / start frame.'
      );
    }

    if (params.lastFramePath) {
      const uploaded = await this.uploadFile(params.lastFramePath);
      inputItems.push({
        type: 'image',
        uri: uploaded.uri,
        mime_type: uploaded.mimeType,
      });
      promptLines.push(
        'Use the second attached image strictly as the closing / end frame and interpolate smoothly from the start frame to the end frame.'
      );
    }

    for (const refPath of params.referenceImagePaths ?? []) {
      const uploaded = await this.uploadFile(refPath);
      inputItems.push({
        type: 'image',
        uri: uploaded.uri,
        mime_type: uploaded.mimeType,
      });
    }

    inputItems.unshift({
      type: 'text',
      text: promptLines.join('\n'),
    });

    const payload: Record<string, unknown> = {
      model: validated.model,
      input: inputItems,
      store: params.store ?? true,
      response_format: {
        type: 'video',
        delivery: 'uri',
        duration: `${validated.durationSeconds}s`,
        resolution: validated.resolution,
        aspect_ratio: validated.aspectRatio,
      },
    };

    return this.executeInteraction(payload, {
      model: validated.model,
      durationSeconds: validated.durationSeconds,
      resolution: validated.resolution,
      aspectRatio: validated.aspectRatio,
      outputPath: params.outputPath,
      pollIntervalMs: params.pollIntervalMs,
      timeoutMs: params.timeoutMs,
    });
  }

  async editOrExtendVideo(
    params: OmniEditOrExtendParams
  ): Promise<OmniVideoResult> {
    const model = params.model ?? this.defaultModel;
    const durationSeconds = params.durationSeconds ?? 5;
    const resolution = params.resolution ?? '720p';
    const aspectRatio = params.aspectRatio ?? '9:16';

    if (durationSeconds < 3 || durationSeconds > 10) {
      throw new Error(
        `Invalid durationSeconds=${durationSeconds}. Video extension/edit turns support 3 to 10 seconds.`
      );
    }

    const refCount = params.referenceImagePaths?.length ?? 0;
    if (refCount > 6) {
      throw new Error(
        `Too many reference images (${refCount}). Maximum is 6.`
      );
    }

    const inputItems: Array<Record<string, unknown>> = [
      { type: 'text', text: params.prompt.trim() },
    ];

    for (const refPath of params.referenceImagePaths ?? []) {
      const uploaded = await this.uploadFile(refPath);
      inputItems.push({
        type: 'image',
        uri: uploaded.uri,
        mime_type: uploaded.mimeType,
      });
    }

    const payload: Record<string, unknown> = {
      model,
      previous_interaction_id: params.previousInteractionId,
      input: inputItems,
      store: params.store ?? true,
      response_format: {
        type: 'video',
        delivery: 'uri',
        duration: `${durationSeconds}s`,
        resolution,
        aspect_ratio: aspectRatio,
      },
    };

    return this.executeInteraction(payload, {
      model,
      durationSeconds,
      resolution,
      aspectRatio,
      outputPath: params.outputPath,
      pollIntervalMs: params.pollIntervalMs,
      timeoutMs: params.timeoutMs,
    });
  }

  private async executeInteraction(
    payload: Record<string, unknown>,
    meta: {
      model: string;
      durationSeconds: number;
      resolution: VideoResolution;
      aspectRatio: VideoAspectRatio;
      outputPath?: string;
      pollIntervalMs?: number;
      timeoutMs?: number;
    }
  ): Promise<OmniVideoResult> {
    const apiKey = this.requireApiKey();

    const createRes = await this.fetchImpl(
      `${this.baseUrl}/v1beta/interactions`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(
        `Gemini Omni Interactions API failed (${createRes.status}): ${errText}`
      );
    }

    let interaction = (await createRes.json()) as {
      id?: string;
      status?: string;
      outputs?: Array<{
        type?: string;
        uri?: string;
        data?: string;
        mime_type?: string;
        mimeType?: string;
      }>;
      error?: { message?: string; code?: number };
    };

    const interactionId = interaction.id ?? '';
    const pollIntervalMs = meta.pollIntervalMs ?? 5000;
    const timeoutMs = meta.timeoutMs ?? 600_000;
    const deadline = Date.now() + timeoutMs;

    while (
      interactionId &&
      interaction.status &&
      ['in_progress', 'queued', 'pending', 'running'].includes(
        interaction.status.toLowerCase()
      ) &&
      Date.now() < deadline
    ) {
      await sleep(pollIntervalMs);
      const pollRes = await this.fetchImpl(
        `${this.baseUrl}/v1beta/interactions/${encodeURIComponent(interactionId)}`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
        }
      );
      if (!pollRes.ok) {
        const errText = await pollRes.text();
        throw new Error(
          `Polling interaction ${interactionId} failed (${pollRes.status}): ${errText}`
        );
      }
      interaction = (await pollRes.json()) as typeof interaction;
    }

    if (
      interaction.status &&
      ['failed', 'error', 'cancelled'].includes(
        interaction.status.toLowerCase()
      )
    ) {
      throw new Error(
        `Gemini Omni interaction ${interactionId} ended with status=${interaction.status}: ${interaction.error?.message ?? 'Unknown error'}`
      );
    }

    const outputs = interaction.outputs ?? [];
    const videoOutput = outputs.find(
      (o) =>
        o.type === 'video' ||
        (o.mime_type ?? o.mimeType ?? '').startsWith('video/')
    );

    const videoUri = videoOutput?.uri;
    const mimeType = videoOutput?.mime_type ?? videoOutput?.mimeType ?? 'video/mp4';
    let savedPath: string | undefined;

    if (videoOutput?.uri || videoOutput?.data) {
      const targetPath = path.resolve(
        meta.outputPath ??
          path.join(
            this.outputDir,
            `omni_${interactionId || Date.now()}.mp4`
          )
      );
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      if (videoOutput.data) {
        fs.writeFileSync(targetPath, Buffer.from(videoOutput.data, 'base64'));
        savedPath = targetPath;
      } else if (videoOutput.uri) {
        const downloadRes = await this.fetchImpl(videoOutput.uri, {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
        });
        if (!downloadRes.ok) {
          const errText = await downloadRes.text();
          throw new Error(
            `Failed to download video from ${videoOutput.uri} (${downloadRes.status}): ${errText}`
          );
        }
        const arrayBuf = await downloadRes.arrayBuffer();
        fs.writeFileSync(targetPath, Buffer.from(arrayBuf));
        savedPath = targetPath;
      }
    }

    return {
      interactionId,
      model: meta.model,
      status: interaction.status ?? 'completed',
      outputPath: savedPath,
      videoUri,
      mimeType,
      durationSeconds: meta.durationSeconds,
      resolution: meta.resolution,
      aspectRatio: meta.aspectRatio,
      rawOutputs: outputs,
    };
  }
}
