#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createGoogleFlowMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createGoogleFlowMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // MCP servers MUST log only to stderr (stdout is reserved for JSON-RPC frames)
  console.error(
    `[google-flow-mcp] started (defaultBackend=${config.defaultBackend}, cdp=${config.chromeCdpUrl}, omniKey=${config.googleApiKey ? 'configured' : 'unset'})`
  );
}

main().catch((err) => {
  console.error('[google-flow-mcp] fatal error:', err);
  process.exit(1);
});
