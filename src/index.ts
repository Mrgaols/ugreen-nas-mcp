#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { ConfirmStore } from './confirm.js';
import { INSTALL_HINT } from './output.js';
import { buildServer } from './server.js';
import { locateUnc } from './unc/locate.js';
import { createRunner, killActiveChildren } from './unc/runner.js';

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
const missingUncHint =
  uncBin !== null
    ? undefined
    : config.uncBin !== null
      ? `UGREEN_MCP_UNC_BIN points to "${config.uncBin}", which is not an executable file. Ask the user to correct ` +
        'the path in the MCP server configuration, or to remove the variable so unc is looked up on PATH. ' +
        'This cannot be fixed by calling another tool.'
      : INSTALL_HINT;
if (missingUncHint) log(`[ugreen-nas-mcp] ${missingUncHint}`);

const server = buildServer({
  config,
  runner: uncBin === null ? null : createRunner(uncBin, process.env),
  confirm: new ConfirmStore(),
  version: readVersion(),
  log,
  ...(missingUncHint ? { missingUncHint } : {}),
});

// A unc process must not outlive the server: its result could no longer be delivered, and an agent that
// reconnects might submit the same operation again.
const shutdown = (code: number) => {
  killActiveChildren();
  process.exit(code);
};
process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
process.once('SIGHUP', () => shutdown(129));
// The client closing stdin is how a stdio server learns that the client is gone.
process.stdin.once('end', () => shutdown(0));
process.stdin.once('close', () => shutdown(0));

await server.connect(new StdioServerTransport());
log(`[ugreen-nas-mcp] ready: access=${config.access} toolsets=${[...config.toolsets].join(',')}`);
