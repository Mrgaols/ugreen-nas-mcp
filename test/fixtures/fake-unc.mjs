#!/usr/bin/env node
// Stand-in for the real `unc` binary in tests. Behaviour is selected with FAKE_UNC_MODE.
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_UNC_MODE || 'echo';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

switch (mode) {
  case 'fail':
    process.stdout.write(JSON.stringify({ success: false, error: 'NotFound (HTTP 404) /x: no such file' }) + '\n');
    process.stderr.write('Error: 1/1 个目标失败\n');
    process.exitCode = 1;
    break;
  case 'stderr-only':
    process.stderr.write('Error: 尚未登录，请先运行 unc auth login，或设置 UNC_NAS_TOKEN + UNC_NAS_URL\n');
    process.exitCode = 1;
    break;
  case 'garbage':
    process.stdout.write('not json at all\n');
    break;
  case 'hang':
    if (process.env.FAKE_UNC_PIDFILE) writeFileSync(process.env.FAKE_UNC_PIDFILE, String(process.pid));
    setTimeout(() => {}, 60_000);
    break;
  case 'big':
    process.stdout.write(JSON.stringify({ success: true, data: 'x'.repeat(5_000_000) }));
    break;
  case 'raw':
    process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x68, 0x69]));
    break;
  default: {
    const stdin = await readStdin();
    process.stdout.write(JSON.stringify({ success: true, argv: process.argv.slice(2), stdin }) + '\n');
  }
}
