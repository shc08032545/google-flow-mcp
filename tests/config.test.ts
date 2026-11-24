import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTORS, loadConfig, loadSelectors } from '../src/config.js';

describe('config & selectors', () => {
  it('loads sensible defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.defaultBackend).toBe('cdp');
    expect(cfg.chromeCdpUrl).toBe('http://127.0.0.1:9222');
    expect(cfg.flowUrlMatch).toBe('flow.google.com');
    expect(cfg.omniDefaultModel).toBe('gemini-omni-1.2-flash');
    expect(cfg.googleApiKey).toBeUndefined();
    expect(cfg.selectors).toEqual(DEFAULT_SELECTORS);
  });

  it('supports GEMINI_API_KEY fallback and api backend', () => {
    const cfg = loadConfig({
      FLOW_DEFAULT_BACKEND: 'api',
      GEMINI_API_KEY: 'test-gemini-key',
      OMNI_DEFAULT_MODEL: 'gemini-omni-1.1-flash',
    });
    expect(cfg.defaultBackend).toBe('api');
    expect(cfg.googleApiKey).toBe('test-gemini-key');
    expect(cfg.omniDefaultModel).toBe('gemini-omni-1.1-flash');
  });

  it('merges partial custom selectors.json over DEFAULT_SELECTORS', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-cfg-'));
    try {
      const selPath = path.join(tmpDir, 'selectors.json');
      fs.writeFileSync(
        selPath,
        JSON.stringify({ promptInput: ['textarea#custom-flow-prompt'] }),
        'utf8'
      );

      const loaded = loadSelectors(selPath);
      expect(loaded.promptInput).toEqual(['textarea#custom-flow-prompt']);
      expect(loaded.generateButton).toEqual(DEFAULT_SELECTORS.generateButton);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
