import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';

export interface SplitStoryboardOptions {
  /** Fraction of each panel height to trim from the top (removes timecode/label bars). Default: 0.065 */
  headerTrimRatio?: number;
  /** Fraction of each panel height to trim from the bottom. Default: 0.01 */
  footerTrimRatio?: number;
  /** Pixels to trim from all four sides of each panel to remove grid borders. Default: 6 */
  borderTrimPx?: number;
  /** Output format: jpg or png. Default: jpg */
  format?: 'jpg' | 'png';
  /** Optional filename prefix (e.g. "scene_01_"). Default: "" */
  prefix?: string;
}

export interface CroppedPanel {
  panelNumber: 1 | 2 | 3 | 4;
  role: 'start' | 'mid_1' | 'mid_2' | 'end';
  filePath: string;
  width: number;
  height: number;
}

export interface SplitStoryboardResult {
  sourcePath: string;
  sourceWidth: number;
  sourceHeight: number;
  outputDir: string;
  panels: CroppedPanel[];
  startFramePath: string;
  endFramePath: string;
}

const PANEL_META: Array<{
  panelNumber: 1 | 2 | 3 | 4;
  role: 'start' | 'mid_1' | 'mid_2' | 'end';
  row: 0 | 1;
  col: 0 | 1;
  suffix: string;
}> = [
  { panelNumber: 1, role: 'start', row: 0, col: 0, suffix: 'panel_1_start' },
  { panelNumber: 2, role: 'mid_1', row: 0, col: 1, suffix: 'panel_2' },
  { panelNumber: 3, role: 'mid_2', row: 1, col: 0, suffix: 'panel_3' },
  { panelNumber: 4, role: 'end', row: 1, col: 1, suffix: 'panel_4_end' },
];

export async function splitStoryboardSheet(
  imagePath: string,
  outputDir: string,
  options: SplitStoryboardOptions = {}
): Promise<SplitStoryboardResult> {
  const resolvedSource = path.resolve(imagePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Storyboard image not found: ${resolvedSource}`);
  }

  const headerTrimRatio = Math.min(
    Math.max(options.headerTrimRatio ?? 0.065, 0),
    0.3
  );
  const footerTrimRatio = Math.min(
    Math.max(options.footerTrimRatio ?? 0.01, 0),
    0.2
  );
  const borderTrimPx = Math.max(Math.round(options.borderTrimPx ?? 6), 0);
  const format = options.format ?? 'jpg';
  const prefix = options.prefix ?? '';

  const resolvedOutDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutDir, { recursive: true });

  const source = await Jimp.read(resolvedSource);
  const sourceWidth = source.bitmap.width;
  const sourceHeight = source.bitmap.height;

  const halfW = Math.floor(sourceWidth / 2);
  const halfH = Math.floor(sourceHeight / 2);

  if (halfW < 32 || halfH < 32) {
    throw new Error(
      `Storyboard image too small to split into 2x2 grid: ${sourceWidth}x${sourceHeight}`
    );
  }

  const headerTrimPx = Math.round(halfH * headerTrimRatio);
  const footerTrimPx = Math.round(halfH * footerTrimRatio);

  const panels: CroppedPanel[] = [];

  for (const meta of PANEL_META) {
    const baseX = meta.col * halfW;
    const baseY = meta.row * halfH;

    const x = Math.min(baseX + borderTrimPx, sourceWidth - 1);
    const y = Math.min(baseY + borderTrimPx + headerTrimPx, sourceHeight - 1);
    const w = Math.max(16, halfW - borderTrimPx * 2);
    const h = Math.max(
      16,
      halfH - borderTrimPx * 2 - headerTrimPx - footerTrimPx
    );

    const safeW = Math.min(w, sourceWidth - x);
    const safeH = Math.min(h, sourceHeight - y);

    const panel = source.clone().crop({ x, y, w: safeW, h: safeH });
    const ext = format === 'png' ? 'png' : 'jpg';
    const filePath = path.join(resolvedOutDir, `${prefix}${meta.suffix}.${ext}`);
    await panel.write(filePath as `${string}.${string}`);

    panels.push({
      panelNumber: meta.panelNumber,
      role: meta.role,
      filePath,
      width: panel.bitmap.width,
      height: panel.bitmap.height,
    });
  }

  return {
    sourcePath: resolvedSource,
    sourceWidth,
    sourceHeight,
    outputDir: resolvedOutDir,
    panels,
    startFramePath: panels[0].filePath,
    endFramePath: panels[3].filePath,
  };
}

export interface ExtractedScenePrompt {
  sceneNumber: number;
  header: string;
  prompt: string;
}

/**
 * Extracts per-scene Story-to-Video prompts from a Motion Infographic Affiliate
 * Master Prompt markdown file (Phase C: `--- SCENE N (...) ---` blocks).
 */
export function extractScenePrompts(markdown: string): ExtractedScenePrompt[] {
  const normalized = markdown.replace(/\r\n/g, '\n');

  // Focus on Phase C if present so we don't accidentally match Phase B storyboard descriptions
  const phaseCMatch = normalized.match(
    /PHASE\s+C\b[^\n]*\n([\s\S]*?)(?=\n={5,}\s*\n\s*PHASE\s+D\b|\n##\s+PHASE\s+D\b|\nPHASE\s+D\b|$)/i
  );
  const scope = phaseCMatch ? phaseCMatch[1] : normalized;

  const parseByHeaderRegex = (headerRegex: RegExp): ExtractedScenePrompt[] => {
    const matches = Array.from(scope.matchAll(headerRegex));
    if (matches.length === 0) return [];

    const results: ExtractedScenePrompt[] = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const next = matches[i + 1];
      const sceneNumber = Number.parseInt(current[1], 10);
      const headerSuffix = (current[2] ?? '').trim();
      const bodyStart = (current.index ?? 0) + current[0].length;
      const bodyEnd = next?.index ?? scope.length;

      // Trim any trailing divider line (`======...`) or next Phase heading
      const rawBody = scope.slice(bodyStart, bodyEnd);
      const cleanedBody = rawBody
        .replace(/\n={5,}[\s\S]*$/, '')
        .replace(/\n#{1,3}\s+PHASE\b[\s\S]*$/i, '')
        .trim();

      if (cleanedBody.length > 0) {
        results.push({
          sceneNumber,
          header: `SCENE ${sceneNumber}${headerSuffix ? ` ${headerSuffix}` : ''}`,
          prompt: cleanedBody,
        });
      }
    }

    return results.sort((a, b) => a.sceneNumber - b.sceneNumber);
  };

  const primary = parseByHeaderRegex(
    /^---\s*SCENE\s+(\d+)\b([^\n]*)---\s*(?:\n|$)/gim
  );
  if (primary.length > 0) {
    return primary;
  }

  return parseByHeaderRegex(
    /^#{2,4}\s*SCENE\s+(\d+)\b([^\n]*)(?:\n|$)/gim
  );
}

export interface PreparedAffiliateScene {
  sceneNumber: number;
  storyboardPath: string;
  startFramePath: string;
  endFramePath: string;
  allPanelPaths: string[];
  promptFilePath?: string;
  promptPreview?: string;
  ingredients: string[];
}

export interface PrepareAffiliatePackResult {
  packDir: string;
  outputDir: string;
  manifestPath: string;
  masterPromptPath?: string;
  ingredients: string[];
  scenes: PreparedAffiliateScene[];
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function findMatchingAsset(files: string[], baseNames: string[]): string | undefined {
  for (const base of baseNames) {
    const found = files.find((f) => {
      const ext = path.extname(f).toLowerCase();
      const stem = path.basename(f, ext).toUpperCase();
      return IMAGE_EXTENSIONS.has(ext) && stem === base.toUpperCase();
    });
    if (found) return found;
  }
  return undefined;
}

export async function prepareAffiliatePack(
  packDir: string,
  outputDir?: string,
  splitOptions: SplitStoryboardOptions = {}
): Promise<PrepareAffiliatePackResult> {
  const resolvedPackDir = path.resolve(packDir);
  if (!fs.existsSync(resolvedPackDir)) {
    throw new Error(`Affiliate pack directory not found: ${resolvedPackDir}`);
  }

  const resolvedOutDir = path.resolve(
    outputDir ?? path.join(resolvedPackDir, 'flow_ready')
  );
  fs.mkdirSync(resolvedOutDir, { recursive: true });

  const entries = fs.readdirSync(resolvedPackDir);

  // Locate shared Ingredients (PRODUCT-01, CHAR-A, LOC-01)
  const ingredients: string[] = [];
  for (const candidates of [
    ['PRODUCT-01', 'PRODUCT_01'],
    ['CHAR-A', 'CHAR_A'],
    ['LOC-01', 'LOC_01'],
  ]) {
    const match = findMatchingAsset(entries, candidates);
    if (match) {
      ingredients.push(path.join(resolvedPackDir, match));
    }
  }

  // Locate Master Prompt Markdown if present
  const masterPromptFile = entries.find(
    (f) => f.toLowerCase().endsWith('.md') && f.toUpperCase().includes('MASTER_PROMPT')
  );
  const masterPromptPath = masterPromptFile
    ? path.join(resolvedPackDir, masterPromptFile)
    : undefined;

  const extractedPrompts = masterPromptPath
    ? extractScenePrompts(fs.readFileSync(masterPromptPath, 'utf8'))
    : [];
  const promptByScene = new Map<number, ExtractedScenePrompt>(
    extractedPrompts.map((p) => [p.sceneNumber, p])
  );

  // Discover STORYBOARD-SCENE-01 / 02 / 03 ...
  const storyboardFiles = entries
    .map((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) return null;
      const m = name.match(/^STORYBOARD[-_ ]SCENE[-_ ]0*(\d+)\./i);
      if (!m) return null;
      return {
        sceneNumber: Number.parseInt(m[1], 10),
        filePath: path.join(resolvedPackDir, name),
      };
    })
    .filter((item): item is { sceneNumber: number; filePath: string } => item !== null)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);

  if (storyboardFiles.length === 0) {
    throw new Error(
      `No STORYBOARD-SCENE-XX image files found in ${resolvedPackDir}`
    );
  }

  const scenes: PreparedAffiliateScene[] = [];

  for (const sb of storyboardFiles) {
    const sceneLabel = `scene_${String(sb.sceneNumber).padStart(2, '0')}`;
    const sceneOutDir = path.join(resolvedOutDir, sceneLabel);

    const split = await splitStoryboardSheet(sb.filePath, sceneOutDir, {
      ...splitOptions,
      prefix: `${sceneLabel}_`,
    });

    const extracted = promptByScene.get(sb.sceneNumber);
    let promptFilePath: string | undefined;
    let promptPreview: string | undefined;

    if (extracted) {
      promptFilePath = path.join(resolvedOutDir, `${sceneLabel}_prompt.txt`);
      const flowFriendlyPrompt = [
        extracted.prompt,
        '',
        '[FLOW HELPER NOTE] Use the cropped start frame (panel 1) and end frame (panel 4), plus PRODUCT-01 / CHAR-A / LOC-01 as ingredients. Render full-frame 9:16 continuous motion without any 2x2 grid or borders.',
      ].join('\n');
      fs.writeFileSync(promptFilePath, flowFriendlyPrompt, 'utf8');
      promptPreview = extracted.prompt.slice(0, 220);
    }

    scenes.push({
      sceneNumber: sb.sceneNumber,
      storyboardPath: sb.filePath,
      startFramePath: split.startFramePath,
      endFramePath: split.endFramePath,
      allPanelPaths: split.panels.map((p) => p.filePath),
      promptFilePath,
      promptPreview,
      ingredients,
    });
  }

  const manifestPath = path.join(resolvedOutDir, 'manifest.json');
  const manifest = {
    generatedAt: new Date().toISOString(),
    packDir: resolvedPackDir,
    outputDir: resolvedOutDir,
    masterPromptPath,
    ingredients,
    scenes,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    packDir: resolvedPackDir,
    outputDir: resolvedOutDir,
    manifestPath,
    masterPromptPath,
    ingredients,
    scenes,
  };
}
