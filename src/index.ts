#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { ConfirmStore } from './confirm.js';
import { INSTALL_HINT } from './output.js';
import { buildServer } from './server.js';
import { locateUnc } from './unc/locate.js';
import { createRunner } from './unc/runner.js';

// stdout carries the MCP protocol, so everything meant for a human goes to stderr.
const log = (line: string) => process.stderr.write(line + '\n');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadConfigOrExit(): Config {
  try {
    const config = loadConfig(process.env);
    if (config.localDir !== null) {
      let isDirectory = false;
      try {
        isDirectory = statSync(config.localDir).isDirectory();
      } catch {
        // reported below
      }
      if (!isDirectory) throw new ConfigError(`UGREEN_MCP_LOCAL_DIR is not an existing directory: "${config.localDir}".`);
    }
    return config;
  } catch (err) {
    log(`[ugreen-nas-mcp] configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

const config = loadConfigOrExit();
const uncBin = await locateUnc(config.uncBin);
if (uncBin === null) log(`[ugreen-nas-mcp] ${INSTALL_HINT}`);

const server = buildServer({
  config,
  runner: uncBin === null ? null : createRunner(uncBin, process.env),
  confirm: new ConfirmStore(),
  version: readVersion(),
  log,
});

await server.connect(new StdioServerTransport());
log(`[ugreen-nas-mcp] ready: access=${config.access} toolsets=${[...config.toolsets].join(',')}`);
