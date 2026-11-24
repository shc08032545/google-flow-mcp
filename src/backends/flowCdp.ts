import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { AppConfig, FlowSelectors } from '../config.js';

export interface CdpStatusResult {
  connected: boolean;
  cdpUrl: string;
  flowUrlMatch: string;
  flowPageFound: boolean;
  activeFlowUrl?: string;
  activeFlowTitle?: string;
  openPages: Array<{ url: string; title: string }>;
  error?: string;
}

export interface CdpGenerateParams {
  prompt: string;
  storyboardSheetPath?: string;
  firstFramePath?: string;
  lastFramePath?: string;
  referenceImagePaths?: string[];
  modelLabel?: string;
  durationSeconds?: number;
  aspectRatio?: '9:16' | '16:9';
  outputPath?: string;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  openFlowIfMissing?: boolean;
}

export interface CdpGenerateResult {
  status: 'submitted' | 'completed' | 'timeout';
  pageUrl: string;
  attachedFiles: string[];
  promptFilled: boolean;
  generateClicked: boolean;
  outputPath?: string;
  videoSrc?: string;
  notes: string[];
}

export interface DomInspectItem {
  tag: string;
  role?: string | null;
  type?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  text?: string | null;
  id?: string | null;
  className?: string | null;
}

export interface DomInspectResult {
  pageUrl: string;
  pageTitle: string;
  counts: {
    textareas: number;
    contentEditables: number;
    fileInputs: number;
    buttons: number;
    videos: number;
  };
  elements: DomInspectItem[];
}

async function findFirstVisible(
  page: Page,
  selectors: string[]
): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count > 0 && (await loc.isVisible().catch(() => false))) {
        return { locator: loc, selector };
      }
    } catch {
      // Try next selector
    }
  }
  return null;
}

async function findFirstExisting(
  page: Page,
  selectors: string[]
): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0) {
        return { locator: loc, selector };
      }
    } catch {
      // Try next selector
    }
  }
  return null;
}

async function trySelectOption(
  page: Page,
  triggerSelectors: string[] | undefined,
  optionTexts: string[],
  label: string,
  notes: string[]
): Promise<void> {
  if (!triggerSelectors || triggerSelectors.length === 0) return;

  const trigger = await findFirstVisible(page, triggerSelectors);
  if (!trigger) {
    notes.push(`${label} selector not matched; keeping current Flow UI setting.`);
    return;
  }

  const currentText = (await trigger.locator.textContent().catch(() => '')) ?? '';
  if (
    optionTexts.some((t) =>
      currentText.toLowerCase().includes(t.toLowerCase())
    )
  ) {
    notes.push(`${label} already active (${currentText.trim()}).`);
    return;
  }

  await trigger.locator.click().catch(() => undefined);
  await page.waitForTimeout(350);

  for (const text of optionTexts) {
    const option = page
      .locator(
        `[role="option"]:has-text("${text}"), [role="menuitem"]:has-text("${text}"), button:has-text("${text}"), li:has-text("${text}")`
      )
      .first();
    if ((await option.count().catch(() => 0)) > 0 && (await option.isVisible().catch(() => false))) {
      await option.click().catch(() => undefined);
      await page.waitForTimeout(300);
      notes.push(`Selected ${label}: ${text}.`);
      return;
    }
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  notes.push(
    `Opened ${label} menu but none of [${optionTexts.join(', ')}] matched; verify manually or update selectors.json.`
  );
}

export class FlowCdpClient {
  private readonly cdpUrl: string;
  private readonly flowUrlMatch: string;
  private readonly selectors: FlowSelectors;
  private readonly outputDir: string;

  constructor(config: AppConfig) {
    this.cdpUrl = config.chromeCdpUrl;
    this.flowUrlMatch = config.flowUrlMatch;
    this.selectors = config.selectors;
    this.outputDir = config.outputDir;
  }

  private async connect(): Promise<Browser> {
    return chromium.connectOverCDP(this.cdpUrl, { timeout: 10_000 });
  }

  private async getFlowPage(
    browser: Browser,
    openIfMissing = false
  ): Promise<Page | null> {
    const contexts = browser.contexts();
    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        if (page.url().toLowerCase().includes(this.flowUrlMatch.toLowerCase())) {
          return page;
        }
      }
    }

    if (openIfMissing) {
      const ctx = contexts[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      await page.goto('https://flow.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      return page;
    }

    return null;
  }

  async checkStatus(): Promise<CdpStatusResult> {
    let browser: Browser | undefined;
    try {
      browser = await this.connect();
      const openPages: Array<{ url: string; title: string }> = [];
      let flowPage: Page | null = null;

      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          const url = page.url();
          const title = await page.title().catch(() => '');
          openPages.push({ url, title });
          if (
            !flowPage &&
            url.toLowerCase().includes(this.flowUrlMatch.toLowerCase())
          ) {
            flowPage = page;
          }
        }
      }

      return {
        connected: true,
        cdpUrl: this.cdpUrl,
        flowUrlMatch: this.flowUrlMatch,
        flowPageFound: Boolean(flowPage),
        activeFlowUrl: flowPage?.url(),
        activeFlowTitle: flowPage
          ? await flowPage.title().catch(() => '')
          : undefined,
        openPages,
      };
    } catch (err) {
      return {
        connected: false,
        cdpUrl: this.cdpUrl,
        flowUrlMatch: this.flowUrlMatch,
        flowPageFound: false,
        openPages: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async generateVideo(params: CdpGenerateParams): Promise<CdpGenerateResult> {
    const filesToAttach: string[] = [];
    for (const maybePath of [
      params.storyboardSheetPath,
      params.firstFramePath,
      params.lastFramePath,
      ...(params.referenceImagePaths ?? []),
    ]) {
      if (!maybePath) continue;
      const resolved = path.resolve(maybePath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Attachment file not found: ${resolved}`);
      }
      filesToAttach.push(resolved);
    }

    const browser = await this.connect();
    const notes: string[] = [];

    try {
      const page = await this.getFlowPage(
        browser,
        params.openFlowIfMissing ?? false
      );
      if (!page) {
        throw new Error(
          `No open browser tab matching "${this.flowUrlMatch}" found at ${this.cdpUrl}. Open https://flow.google.com/ in Chrome (launched with --remote-debugging-port=9222) and sign in first.`
        );
      }

      await page.bringToFront().catch(() => undefined);

      // Optional: Attempt to align Flow UI model, duration, and aspect ratio
      if (params.modelLabel) {
        const candidates =
          params.modelLabel.includes('1.1')
            ? ['Omni 1.1 Flash', 'Omni Flash 1.1', '1.1 Flash', 'Omni 1.1']
            : params.modelLabel.includes('1.2')
              ? ['Omni 1.2 Flash', 'Omni Flash 1.2', '1.2 Flash', 'Omni 1.2']
              : [params.modelLabel];
        await trySelectOption(
          page,
          this.selectors.modelSelector,
          candidates,
          'Model',
          notes
        );
      }
      if (params.durationSeconds) {
        await trySelectOption(
          page,
          this.selectors.durationSelector,
          [`${params.durationSeconds}s`, `${params.durationSeconds} sec`],
          'Duration',
          notes
        );
      }
      if (params.aspectRatio) {
        const ratioCandidates =
          params.aspectRatio === '9:16'
            ? ['9:16', 'Portrait', 'Vertical']
            : ['16:9', 'Landscape'];
        await trySelectOption(
          page,
          this.selectors.aspectRatioSelector,
          ratioCandidates,
          'Aspect Ratio',
          notes
        );
      }

      // Record existing video sources before submitting so we can detect newly generated video
      const previousVideoSrcs = new Set<string>(
        await this.collectVideoSources(page)
      );

      // Step 1: Attach image files if requested
      const attachedFiles: string[] = [];
      if (filesToAttach.length > 0) {
        const fileInput = await findFirstExisting(
          page,
          this.selectors.fileInput
        );
        if (fileInput) {
          const allowsMultiple = await fileInput.locator
            .evaluate((el) => (el as HTMLInputElement).multiple)
            .catch(() => false);
          if (allowsMultiple) {
            await fileInput.locator.setInputFiles(filesToAttach);
            attachedFiles.push(...filesToAttach);
            notes.push(
              `Attached ${filesToAttach.length} file(s) via ${fileInput.selector}.`
            );
          } else {
            await fileInput.locator.setInputFiles(filesToAttach[0]);
            attachedFiles.push(filesToAttach[0]);
            notes.push(
              `Attached ${path.basename(filesToAttach[0])} via single-file input (${fileInput.selector}).`
            );
            if (filesToAttach.length > 1) {
              notes.push(
                `Note: file input accepts 1 file at a time; remaining ${filesToAttach.length - 1} file(s) may need a second slot in Flow UI.`
              );
            }
          }
        } else {
          const attachBtn = await findFirstVisible(
            page,
            this.selectors.attachButton
          );
          if (attachBtn) {
            const [chooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
              attachBtn.locator.click(),
            ]);
            if (chooser) {
              await chooser.setFiles(
                chooser.isMultiple() ? filesToAttach : filesToAttach[0]
              );
              attachedFiles.push(
                ...(chooser.isMultiple() ? filesToAttach : [filesToAttach[0]])
              );
              notes.push(
                `Attached file(s) via file chooser triggered by ${attachBtn.selector}.`
              );
            } else {
              notes.push(
                `Clicked ${attachBtn.selector}, but no native file chooser opened. Run flow_inspect_dom to customize selectors.json.`
              );
            }
          } else {
            notes.push(
              'No file input or attach button matched current selectors. Run flow_inspect_dom / flow_screenshot to update selectors.json.'
            );
          }
        }
        await page.waitForTimeout(800);
      }

      // Step 2: Fill prompt
      const promptInput = await findFirstVisible(
        page,
        this.selectors.promptInput
      );
      if (!promptInput) {
        throw new Error(
          `Could not locate prompt input on ${page.url()}. Run flow_inspect_dom or flow_screenshot to inspect current Google Flow selectors and update selectors.json.`
        );
      }

      const tagName = await promptInput.locator.evaluate((el) =>
        el.tagName.toLowerCase()
      );
      await promptInput.locator.click();
      if (tagName === 'textarea' || tagName === 'input') {
        await promptInput.locator.fill(params.prompt);
      } else {
        await page.keyboard.press('ControlOrMeta+A').catch(() => undefined);
        await page.keyboard.insertText(params.prompt);
      }
      notes.push(`Filled prompt via ${promptInput.selector}.`);

      // Step 3: Click Generate
      const generateBtn = await findFirstVisible(
        page,
        this.selectors.generateButton
      );
      let generateClicked = false;
      if (generateBtn) {
        await generateBtn.locator.click();
        generateClicked = true;
        notes.push(`Clicked generate button via ${generateBtn.selector}.`);
      } else {
        await page.keyboard.press('Enter');
        generateClicked = true;
        notes.push(
          'No explicit Generate button matched; submitted with Enter key.'
        );
      }

      if (!params.waitForCompletion) {
        return {
          status: 'submitted',
          pageUrl: page.url(),
          attachedFiles,
          promptFilled: true,
          generateClicked,
          notes,
        };
      }

      // Step 4: Poll for new <video> source
      const timeoutMs = params.timeoutMs ?? 240_000;
      const deadline = Date.now() + timeoutMs;
      let newVideoSrc: string | undefined;

      while (Date.now() < deadline) {
        await page.waitForTimeout(4000);
        const currentSources = await this.collectVideoSources(page);
        const discovered = currentSources.find(
          (src) => src && !previousVideoSrcs.has(src)
        );
        if (discovered) {
          newVideoSrc = discovered;
          break;
        }
      }

      if (!newVideoSrc) {
        notes.push(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a new <video> element. Check the Flow tab or run flow_screenshot.`
        );
        return {
          status: 'timeout',
          pageUrl: page.url(),
          attachedFiles,
          promptFilled: true,
          generateClicked,
          notes,
        };
      }

      // Step 5: Attempt to save the generated video locally (1) browser fetch, (2) Download button fallback
      let savedPath: string | undefined;
      const targetPath = path.resolve(
        params.outputPath ??
          path.join(this.outputDir, `flow_${Date.now()}.mp4`)
      );
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      try {
        const base64Video = await page.evaluate(async (srcUrl: string) => {
          const res = await fetch(srcUrl);
          if (!res.ok) return null;
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(
              ...bytes.subarray(i, i + chunkSize)
            );
          }
          return btoa(binary);
        }, newVideoSrc);

        if (base64Video) {
          fs.writeFileSync(targetPath, Buffer.from(base64Video, 'base64'));
          savedPath = targetPath;
          notes.push(`Downloaded generated video via browser fetch to ${savedPath}.`);
        }
      } catch (downloadErr) {
        notes.push(
          `Browser fetch skipped (${
            downloadErr instanceof Error
              ? downloadErr.message
              : String(downloadErr)
          }); trying Download button...`
        );
      }

      if (!savedPath) {
        const downloadBtn = await findFirstVisible(
          page,
          this.selectors.downloadButton
        );
        if (downloadBtn) {
          try {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 20_000 }),
              downloadBtn.locator.click(),
            ]);
            await download.saveAs(targetPath);
            savedPath = targetPath;
            notes.push(`Downloaded generated video via UI Download button to ${savedPath}.`);
          } catch (btnErr) {
            notes.push(
              `UI Download button click did not emit file download: ${
                btnErr instanceof Error ? btnErr.message : String(btnErr)
              }`
            );
          }
        } else {
          notes.push(
            'Could not auto-download video; download manually from the Flow tab or update downloadButton in selectors.json.'
          );
        }
      }

      return {
        status: 'completed',
        pageUrl: page.url(),
        attachedFiles,
        promptFilled: true,
        generateClicked,
        outputPath: savedPath,
        videoSrc: newVideoSrc,
        notes,
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async takeScreenshot(
    outputPath?: string,
    fullPage = false
  ): Promise<{ filePath: string; pageUrl: string; pageTitle: string }> {
    const browser = await this.connect();
    try {
      const page = await this.getFlowPage(browser, false);
      if (!page) {
        throw new Error(
          `No open tab matching "${this.flowUrlMatch}" found at ${this.cdpUrl}.`
        );
      }
      const targetPath = path.resolve(
        outputPath ??
          path.join(this.outputDir, `flow_screenshot_${Date.now()}.png`)
      );
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await page.screenshot({ path: targetPath, fullPage });
      return {
        filePath: targetPath,
        pageUrl: page.url(),
        pageTitle: await page.title().catch(() => ''),
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async inspectDom(maxElements = 60): Promise<DomInspectResult> {
    const browser = await this.connect();
    try {
      const page = await this.getFlowPage(browser, false);
      if (!page) {
        throw new Error(
          `No open tab matching "${this.flowUrlMatch}" found at ${this.cdpUrl}.`
        );
      }

      const data = await page.evaluate((limit: number) => {
        const query =
          'textarea, [contenteditable="true"], input[type="file"], button, video';
        const all = Array.from(document.querySelectorAll(query));

        const counts = {
          textareas: document.querySelectorAll('textarea').length,
          contentEditables: document.querySelectorAll('[contenteditable="true"]')
            .length,
          fileInputs: document.querySelectorAll('input[type="file"]').length,
          buttons: document.querySelectorAll('button').length,
          videos: document.querySelectorAll('video').length,
        };

        const elements = all.slice(0, limit).map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          type: el.getAttribute('type'),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          text: (el.textContent ?? '').trim().slice(0, 80) || null,
          id: el.id || null,
          className:
            typeof el.className === 'string'
              ? el.className.slice(0, 80) || null
              : null,
        }));

        return { counts, elements };
      }, maxElements);

      return {
        pageUrl: page.url(),
        pageTitle: await page.title().catch(() => ''),
        counts: data.counts,
        elements: data.elements,
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async collectVideoSources(page: Page): Promise<string[]> {
    return page
      .evaluate((selectors: string[]) => {
        const srcs = new Set<string>();
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const direct = el.getAttribute('src');
            if (direct) srcs.add(direct);
            if ('currentSrc' in el && typeof (el as HTMLVideoElement).currentSrc === 'string') {
              const cur = (el as HTMLVideoElement).currentSrc;
              if (cur) srcs.add(cur);
            }
          });
        }
        return Array.from(srcs);
      }, this.selectors.videoElement)
      .catch(() => []);
  }
}
