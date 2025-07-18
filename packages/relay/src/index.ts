#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResult, JSONRPCRequest, JSONRPCResponse, ListToolsRequestSchema, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { initialTools } from './initial_tools.js';

const CACHE_DIR = path.join(os.homedir(), '.vscode-as-mcp-relay-cache');
const TOOLS_CACHE_FILE = path.join(CACHE_DIR, 'tools-list-cache.json');
const MAX_RETRIES = 3;
const RETRY_INTERVAL = 1000; // 1 second

class MCPRelay {
  private mcpServer: McpServer;
  private disabledTools: Set<string>;
  private enabledTools: Set<string> | null;
  constructor(readonly serverUrl: string, disabledTools: string[] = [], enabledTools: string[] = []) {
    this.disabledTools = new Set(disabledTools);
    this.enabledTools = enabledTools.length > 0 ? new Set(enabledTools) : null;
    this.mcpServer = new McpServer({
      name: 'vscode-as-mcp',
      version: '0.0.1',
    }, {
      capabilities: {
        tools: {},
      },
    });

    // Periodically call listTools to update the tools list
    setInterval(async () => {
      let tools: any[];
      try {
        const resp = await this.requestWithRetry(this.serverUrl, JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: Math.floor(Math.random() * 1000000),
        } as JSONRPCRequest));
        const parsedResponse = resp as JSONRPCResponse;
        tools = parsedResponse.result.tools as any[];
        // Filter tools based on enabled/disabled lists
        tools = this.filterTools(tools);
      } catch (err) {
        return;
      }

      const cachedTools = await this.getToolsCache();

      // Compare the fetched tools with the cached ones
      if (cachedTools && cachedTools.length === tools.length) {
        console.error('Fetched tools list is the same as the cached one, not updating cache');
        return { tools: cachedTools };
      }

      // Notify to user that tools have been updated and restart the client
      try {
        await this.requestWithRetry(this.serverUrl + '/notify-tools-updated', '');
      } catch (err) {
        console.error(`Failed to notify tools updated: ${(err as Error).message}`);
      }

      try {
        await this.saveToolsCache(tools);
      } catch (cacheErr) {
        console.error(`Failed to cache tools response: ${(cacheErr as Error).message}`);
      }
    }, 3600000); // every 3600 seconds (1 hour)

    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (request): Promise<ListToolsResult> => {
      const cachedTools = await this.getToolsCache() ?? initialTools;

      let tools: any[];
      try {
        const response = await this.requestWithRetry(this.serverUrl, JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: request.params,
          id: Math.floor(Math.random() * 1000000),
        } as JSONRPCRequest));
        const parsedResponse = response as JSONRPCResponse;
        tools = parsedResponse.result.tools as any[];
      } catch (err) {
        console.error(`Failed to fetch tools list: ${(err as Error).message}`);
        // Filter cached tools based on enabled/disabled lists
        const filteredCachedTools = this.filterTools(cachedTools);
        return { tools: filteredCachedTools as any[] };
      }

      // Update cache
      try {
        await this.saveToolsCache(tools);
      } catch (cacheErr) {
        console.error(`Failed to cache tools response: ${(cacheErr as Error).message}`);
      }

      // Filter tools based on enabled/disabled lists
      const filteredTools = this.filterTools(tools);
      return { tools: filteredTools };
    });

    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      try {
        const response = await this.requestWithRetry(this.serverUrl, JSON.stringify({
          jsonrpc: '2.0',
          method: request.method,
          params: request.params,
          id: Math.floor(Math.random() * 1000000),
        } as JSONRPCRequest));
        const parsedResponse = response as JSONRPCResponse;
        return parsedResponse.result as any;
      } catch (e) {
        console.error(`Failed to call tool: ${(e as Error).message}`);
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Failed to communicate with the VSCode as MCP Extension. Please ensure that the VSCode Extension is installed and that "MCP Server" is displayed in the status bar.`,
          }],
        };
      }
    });
  }
  // キャッシュディレクトリの初期化
  async initCacheDir(): Promise<void> {
    try {
      // ディレクトリが存在しない場合は作成
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    } catch (err) {
      console.error(`Failed to initialize cache directory: ${(err as Error).message}`);
    }
  }

  // キャッシュの保存
  async saveToolsCache(tools: any[]): Promise<void> {
    await this.initCacheDir();
    try {
      await fs.writeFile(TOOLS_CACHE_FILE, JSON.stringify(tools), 'utf8');
      console.error('Tools list cache saved');
    } catch (err) {
      console.error(`Failed to save cache: ${(err as Error).message}`);
    }
  }

  async getToolsCache() {
    try {
      await fs.access(TOOLS_CACHE_FILE);
      const cacheData = await fs.readFile(TOOLS_CACHE_FILE, 'utf8');
      return JSON.parse(cacheData) as any[];
    } catch (err) {
      console.error(`Failed to load cache file: ${(err as Error).message}`);
      return null;
    }
  }

  async requestWithRetry(url: string, body: string): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.error(`Retry attempt ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: body,
        });

        const responseText = await response.text();

        // Only status codes >= 500 are errors
        if (response.status >= 500) {
          lastError = new Error(`Request failed with status ${response.status}: ${responseText}`);
          continue;
        }

        return JSON.parse(responseText);
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw new Error(`All retry attempts failed: ${lastError?.message}`);
  }

  private filterTools(tools: any[]): any[] {
    return tools.filter(tool => {
      // If enabledTools is set, only include tools in the enabled list
      if (this.enabledTools !== null) {
        return this.enabledTools.has(tool.name);
      }
      // Otherwise, exclude tools in the disabled list
      return !this.disabledTools.has(tool.name);
    }).map(tool => this.sanitizeToolSchema(tool));
  }

  private sanitizeToolSchema(tool: any): any {
    if (!tool.inputSchema) {
      return tool;
    }

    // Create a deep copy to avoid modifying the original
    const sanitizedTool = JSON.parse(JSON.stringify(tool));
    
    // Recursively remove unsupported schema features
    const sanitizeSchema = (schema: any): any => {
      if (typeof schema !== 'object' || schema === null) {
        return schema;
      }

      const sanitized = { ...schema };
      
      // Remove unsupported meta-schema features
      delete sanitized.$dynamicRef;
      delete sanitized.$dynamicAnchor;
      delete sanitized.$recursiveRef;
      delete sanitized.$recursiveAnchor;
      
      // Downgrade schema version to draft-07 which is more widely supported
      if (sanitized.$schema && sanitized.$schema.includes('2020-12')) {
        sanitized.$schema = 'http://json-schema.org/draft-07/schema#';
      }
      
      // Recursively sanitize nested objects
      Object.keys(sanitized).forEach(key => {
        if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
          if (Array.isArray(sanitized[key])) {
            sanitized[key] = sanitized[key].map((item: any) => 
              typeof item === 'object' ? sanitizeSchema(item) : item
            );
          } else {
            sanitized[key] = sanitizeSchema(sanitized[key]);
          }
        }
      });
      
      return sanitized;
    };

    sanitizedTool.inputSchema = sanitizeSchema(sanitizedTool.inputSchema);
    return sanitizedTool;
  }

  start() {
    return this.mcpServer.connect(new StdioServerTransport());
  }
};

// コマンドライン引数の解析
function parseArgs() {
  const args = process.argv.slice(2);
  let serverUrl = 'http://localhost:60100';
  const disabledTools: string[] = [];
  const enabledTools: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server-url' && i + 1 < args.length) {
      serverUrl = args[i + 1];
      i++;
    } else if (args[i] === '--disable' && i + 1 < args.length) {
      disabledTools.push(args[i + 1]);
      i++;
    } else if (args[i] === '--enable' && i + 1 < args.length) {
      enabledTools.push(args[i + 1]);
      i++;
    }
  }

  return { serverUrl, disabledTools, enabledTools };
}

try {
  const { serverUrl, disabledTools, enabledTools } = parseArgs();
  const relay = new MCPRelay(serverUrl, disabledTools, enabledTools);
  await relay.start();
} catch (err) {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
}
