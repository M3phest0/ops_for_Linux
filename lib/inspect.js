import { defineTool } from '@deepseek-ai/dsh-tools';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  clampInt,
  sessionCwd,
  displayPath,
  formatBytes,
  isProbablyBinary,
  readTextLimited,
  resolveFrom,
} from './util.js';

const INSPECT_MAX_BYTES = 512 * 1024;
const INSPECT_MAX_LINES = 2000;
const HEX_MAX_BYTES = 8192;

function readHead(absolutePath, bytes = 8192) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    const stream = createReadStream(absolutePath, { start: 0, end: bytes - 1 });
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).subarray(0, size)));
  });
}

async function encodingFacts(absolutePath) {
  try {
    const head = await readHead(absolutePath);
    const binary = isProbablyBinary(head);
    if (binary) return { binary, encoding: 'binary' };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head);
      return { binary, encoding: 'utf-8' };
    } catch {
      return { binary, encoding: 'utf-8 (invalid byte sequences replaced)' };
    }
  } catch {
    return { binary: false, encoding: 'unknown' };
  }
}

async function readLines(absolutePath, offset, limit, maxBytes, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absolutePath, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    let lineNumber = 0;
    let bytes = 0;
    let stopped = false;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      reader.close();
      stream.destroy();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(rejectPromise, new Error('ops_inspect: cancelled'));

    if (signal?.aborted) {
      finish(rejectPromise, new Error('ops_inspect: cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    reader.on('line', (line) => {
      if (stopped) return;
      lineNumber += 1;
      if (lineNumber < offset) return;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      lines.push(line);
      if (lines.length >= limit || bytes >= maxBytes) {
        stopped = true;
        finish(resolvePromise, { lines, lineNumber, stopped: true });
      }
    });
    reader.on('close', () => {
      finish(resolvePromise, { lines, lineNumber, stopped: false });
    });
    stream.on('error', (error) => finish(rejectPromise, error));
  });
}

function formatHex(buffer, baseOffset) {
  const lines = [];
  for (let index = 0; index < buffer.length; index += 16) {
    const chunk = buffer.subarray(index, index + 16);
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const padded = hex.padEnd(47, ' ');
    const text = [...chunk].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${(baseOffset + index).toString(16).padStart(8, '0')}  ${padded}  |${text}|`);
  }
  return lines;
}

async function inspectOne(absolutePath, display, args, signal) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return `[missing or unreadable: ${display}]`;
  }
  if (info.isDirectory()) return `[directory: ${display}]`;
  if (!info.isFile()) return `[not a regular file: ${display}]`;

  if (args.mode === 'meta') {
    const facts = await encodingFacts(absolutePath);
    let lineCount = '?';
    if (info.size <= 4 * 1024 * 1024) {
      try {
        const read = await readTextLimited(absolutePath, 4 * 1024 * 1024);
        lineCount = read.text.split('\n').length - (read.text.endsWith('\n') ? 1 : 0);
      } catch {
        // Leave the line count unknown.
      }
    }
    return [
      `${display}`,
      `  type: file`,
      `  size: ${formatBytes(info.size)} (${info.size} bytes)`,
      `  mode: ${(info.mode & 0o777).toString(8).padStart(3, '0')}`,
      `  mtime: ${new Date(info.mtimeMs).toISOString()}`,
      `  encoding: ${facts.encoding}`,
      `  binary: ${facts.binary ? 'yes' : 'no'}`,
      `  lines: ${lineCount}`,
    ].join('\n');
  }

  if (args.mode === 'hex') {
    const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const length = Math.min(clampInt(args.limit, 1, HEX_MAX_BYTES, 256), HEX_MAX_BYTES);
    const handle = await open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) return `${display}: no bytes at offset ${offset}`;
      const lines = formatHex(buffer.subarray(0, bytesRead), offset);
      if (info.size > offset + bytesRead) lines.push(`[... ${formatBytes(info.size - offset - bytesRead)} more]`);
      return `${display} (hex, offset ${offset})\n${lines.join('\n')}`;
    } finally {
      await handle.close();
    }
  }

  const facts = await encodingFacts(absolutePath);
  if (facts.binary) {
    return `${display}: binary file (${formatBytes(info.size)}); use mode='hex' to inspect bytes`;
  }
  const offset = clampInt(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
  const limit = Math.min(clampInt(args.limit, 1, INSPECT_MAX_LINES, 200), INSPECT_MAX_LINES);
  const maxBytes = clampInt(args.max_bytes, 1024, INSPECT_MAX_BYTES, INSPECT_MAX_BYTES);
  const read = await readLines(absolutePath, offset, limit, maxBytes, signal);
  if (read.lines.length === 0) {
    return `${display}: no lines at offset ${offset} (file has ${read.lineNumber} lines)`;
  }
  const numbered = args.numbered !== false;
  const body = read.lines.map((line, index) => {
    const lineNumber = offset + index;
    return numbered ? `${lineNumber}: ${line}` : line;
  });
  const first = offset;
  const last = offset + read.lines.length - 1;
  const footer = read.stopped
    ? `[lines ${first}-${last}; call again with offset=${last + 1} for more]`
    : `[lines ${first}-${last} of ${read.lineNumber}]`;
  return `${display}\n${body.join('\n')}\n${footer}`;
}

export function registerInspect(ctx, config) {
  const timeoutMs = clampInt(config.grepTimeoutMs, 1000, 600000, 30000);
  ctx.tools.register(defineTool({
    name: 'ops_inspect',
    description: 'Read one or more files on Linux in one call. Returns numbered text ranges, a hex dump for binary bytes, or metadata (size, mode, mtime, encoding, line count). Use this instead of many small read/cat/wc calls. Text output is capped: advance offset for more. Binary files are refused in text mode; choose mode=hex.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, required: true, description: 'Files to inspect. A small batch is cheaper than one call per file.' },
      mode: { type: 'string', enum: ['text', 'hex', 'meta'], description: 'Inspection mode. Default: text.' },
      offset: { type: 'integer', description: 'First line (1-based) in text mode, or first byte (0-based) in hex mode. Default: 1 for text, 0 for hex.' },
      limit: { type: 'integer', description: 'Maximum lines in text mode or bytes in hex mode. Defaults: 200 lines, 256 bytes; hex caps at 8192.' },
      max_bytes: { type: 'integer', description: 'Text-mode byte budget per file. Default: 524288.' },
      numbered: { type: 'boolean', description: 'Prefix text lines with line numbers. Default: true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          files: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec);
      const paths = Array.isArray(args.paths) ? args.paths.filter((value) => typeof value === 'string' && value.length > 0) : [];
      if (paths.length === 0) throw new Error('ops_inspect: paths must contain at least one file');
      if (paths.length > 20) throw new Error('ops_inspect: at most 20 files per call; batch further');
      const mode = args.mode ?? 'text';
      const chunks = [];
      for (const path of paths) {
        const absolutePath = resolveFrom(cwd, path);
        const display = displayPath(cwd, absolutePath);
        chunks.push(await inspectOne(absolutePath, display, { ...args, mode }, exec.signal));
      }
      if (exec.signal.aborted) throw new Error('ops_inspect: cancelled');
      const text = chunks.length === 1 ? chunks[0] : chunks.join('\n\n');
      return { text, files: paths.length };
    },
  }));
}
