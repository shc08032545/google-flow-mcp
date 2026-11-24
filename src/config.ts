import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const BackendSchema = z.enum(['cdp', 'api']);
export type FlowBackend = z.infer<typeof BackendSchema>;

export const OmniModelSchema = z.enum([
  'gemini-omni-1.2-flash',
  'gemini-omni-1.1-flash',
]);
export type OmniModel = z.infer<typeof OmniModelSchema>;

export const SelectorsSchema = z.object({
  promptInput: z.array(z.string().min(1)).min(1),
  generateButton: z.array(z.string().min(1)).min(1),
  fileInput: z.array(z.string().min(1)).min(1),
  attachButton: z.array(z.string().min(1)).min(1),
  modelSelector: z.array(z.string().min(1)).optional(),
  durationSelector: z.array(z.string().min(1)).optional(),
  aspectRatioSelector: z.array(z.string().min(1)).optional(),
  videoElement: z.array(z.string().min(1)).min(1),
  downloadButton: z.array(z.string().min(1)).min(1),
});

export type FlowSelectors = z.infer<typeof SelectorsSchema>;

export const DEFAULT_SELECTORS: FlowSelectors = {
  promptInput: [
    'textarea[placeholder*="Describe" i]',
    'textarea[placeholder*="Generate" i]',
    'textarea[placeholder*="Prompt" i]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ],
  generateButton: [
    'button[aria-label*="Generate" i]',
    'button[aria-label*="Create" i]',
    'button[aria-label*="Send" i]',
    'button:has-text("Generate")',
    'button[type="submit"]',
  ],
  fileInput: ['input[type="file"]'],
  attachButton: [
    'button[aria-label*="Add" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Ingredient" i]',
    'button[aria-label*="Frame" i]',
    'button[aria-label*="Image" i]',
  ],
  modelSelector: [
    'button[aria-label*="Model" i]',
    'button:has-text("Omni")',
    'button:has-text("Veo")',
    '[role="combobox"][aria-label*="Model" i]',
  ],
  durationSelector: [
    'button[aria-label*="Duration" i]',
    'button:has-text("10s")',
    'button:has-text("8s")',
    'button:has-text("5s")',
  ],
  aspectRatioSelector: [
    'button[aria-label*="Aspect" i]',
    'button:has-text("9:16")',
    'button:has-text("16:9")',
    'button:has-text("Portrait")',
  ],
  videoElement: ['video[src]', 'video source[src]', 'video'],
  downloadButton: ['button[aria-label*="Download" i]', 'a[download]'],
};

export interface AppConfig {
  defaultBackend: FlowBackend;
  chromeCdpUrl: string;
  flowUrlMatch: string;
  googleApiKey?: string;
  omniDefaultModel: OmniModel;
  omniApiBaseUrl: string;
  selectorsPath?: string;
  outputDir: string;
  selectors: FlowSelectors;
}

const EnvSchema = z.object({
  FLOW_DEFAULT_BACKEND: BackendSchema.default('cdp'),
  CHROME_CDP_URL: z.string().url().default('http://127.0.0.1:9222'),
  FLOW_URL_MATCH: z.string().min(1).default('flow.google.com'),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OMNI_DEFAULT_MODEL: OmniModelSchema.default('gemini-omni-1.1-flash'),
  OMNI_API_BASE_URL: z
    .string()
    .url()
    .default('https://generativelanguage.googleapis.com'),
  FLOW_SELECTORS_PATH: z.string().optional(),
  FLOW_OUTPUT_DIR: z.string().min(1).default('./outputs'),
});

export function loadSelectors(selectorsPath?: string): FlowSelectors {
  if (!selectorsPath) {
    return DEFAULT_SELECTORS;
  }

  const resolved = path.resolve(selectorsPath);
  if (!fs.existsSync(resolved)) {
    return DEFAULT_SELECTORS;
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as Partial<FlowSelectors>;
  const merged = {
    promptInput: parsed.promptInput ?? DEFAULT_SELECTORS.promptInput,
    generateButton: parsed.generateButton ?? DEFAULT_SELECTORS.generateButton,
    fileInput: parsed.fileInput ?? DEFAULT_SELECTORS.fileInput,
    attachButton: parsed.attachButton ?? DEFAULT_SELECTORS.attachButton,
    modelSelector: parsed.modelSelector ?? DEFAULT_SELECTORS.modelSelector,
    durationSelector:
      parsed.durationSelector ?? DEFAULT_SELECTORS.durationSelector,
    aspectRatioSelector:
      parsed.aspectRatioSelector ?? DEFAULT_SELECTORS.aspectRatioSelector,
    videoElement: parsed.videoElement ?? DEFAULT_SELECTORS.videoElement,
    downloadButton: parsed.downloadButton ?? DEFAULT_SELECTORS.downloadButton,
  };

  return SelectorsSchema.parse(merged);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const parsed = EnvSchema.parse({
    FLOW_DEFAULT_BACKEND: env.FLOW_DEFAULT_BACKEND || undefined,
    CHROME_CDP_URL: env.CHROME_CDP_URL || undefined,
    FLOW_URL_MATCH: env.FLOW_URL_MATCH || undefined,
    GOOGLE_API_KEY: env.GOOGLE_API_KEY || undefined,
    GEMINI_API_KEY: env.GEMINI_API_KEY || undefined,
    OMNI_DEFAULT_MODEL: env.OMNI_DEFAULT_MODEL || undefined,
    OMNI_API_BASE_URL: env.OMNI_API_BASE_URL || undefined,
    FLOW_SELECTORS_PATH: env.FLOW_SELECTORS_PATH || undefined,
    FLOW_OUTPUT_DIR: env.FLOW_OUTPUT_DIR || undefined,
  });

  const apiKey = (parsed.GOOGLE_API_KEY || parsed.GEMINI_API_KEY || '').trim();

  return {
    defaultBackend: parsed.FLOW_DEFAULT_BACKEND,
    chromeCdpUrl: parsed.CHROME_CDP_URL,
    flowUrlMatch: parsed.FLOW_URL_MATCH,
    googleApiKey: apiKey.length > 0 ? apiKey : undefined,
    omniDefaultModel: parsed.OMNI_DEFAULT_MODEL,
    omniApiBaseUrl: parsed.OMNI_API_BASE_URL.replace(/\/+$/, ''),
    selectorsPath: parsed.FLOW_SELECTORS_PATH,
    outputDir: path.resolve(parsed.FLOW_OUTPUT_DIR),
    selectors: loadSelectors(parsed.FLOW_SELECTORS_PATH),
  };
}
