import { spawn } from 'node:child_process';
import { glob, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Directories skipped by default by ops_grep and ops_glob. */
export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  'dist',
  'build',
  'target',
  'coverage',
];

/** Workspace directory a tool call runs against. */
export function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/** Effective session directory, including a committed working_directory change. */
export async function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get?.('workingDirectory');
  if (exec?.agent !== undefined && workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      // Fall back to the recorded session cwd.
    }
  }
  return cwdOf(exec);
}

/** Resolve a model-supplied path against the session cwd. */
export function resolveFrom(cwd, path) {
  const value = typeof path === 'string' && path.length > 0 ? path : '.';
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/** Display an absolute path relative to the session cwd when possible. */
export function displayPath(cwd, absolute) {
  const rel = relative(cwd, absolute);
  const posix = rel.split(sep).join('/');
  if (posix === '') return '.';
  return posix.startsWith('..') || isAbsolute(posix) ? absolute.split(sep).join('/') : posix;
}

/** Convert a platform path to forward slashes for model-facing output. */
export function toPosix(path) {
  return String(path).split(sep).join('/');
}

/** Clamp an integer argument; invalid values fall back. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Keep the first `maxBytes` UTF-8 bytes, appending an ellipsis marker. */
export function headBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n… [truncated]';
}

/** Keep the last `maxBytes` UTF-8 bytes, prefixing an ellipsis marker. */
export function tailBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8');
  return '… [truncated; showing tail]\n' + buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

/** True when a byte buffer looks binary (NUL in the inspected prefix). */
export function isProbablyBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/** Human-readable byte count. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/** Shorten one line for a compact preview. */
export function shorten(text, maxChars) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

/** One-based line number of a character index. */
export function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Quote one path for embedding in a bash command line. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Read a UTF-8 text file with a byte cap. Returns encoding and truncation facts
 * instead of silently mangling a non-text file.
 */
export async function readTextLimited(absolutePath, maxBytes) {
  const buffer = await readFile(absolutePath);
  const truncated = buffer.length > maxBytes;
  const sliced = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const binary = isProbablyBinary(sliced);
  let encoding = 'utf-8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sliced);
  } catch {
    encoding = 'utf-8 (invalid byte sequences replaced)';
  }
  const text = new TextDecoder('utf-8').decode(sliced).replace(/^\uFEFF/, '');
  return { text, totalBytes: buffer.length, truncated, binary, encoding };
}

/**
 * Run a process and collect bounded stdout/stderr. The process is killed on
 * timeout or caller abort. No shell is involved.
 */
export function runCollect(file, args, options = {}) {
  const {
    cwd,
    signal,
    timeoutMs = 30000,
    maxStdoutBytes = 8 * 1024 * 1024,
    maxStderrBytes = 256 * 1024,
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already be gone.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const onAbort = () => {
      kill();
    };

    if (signal?.aborted) {
      kill();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      if (stdoutLen >= maxStdoutBytes) {
        overflow = true;
        return;
      }
      const take = Math.min(chunk.length, maxStdoutBytes - stdoutLen);
      if (take < chunk.length) overflow = true;
      stdout.push(chunk.subarray(0, take));
      stdoutLen += take;
    });
    child.stderr.on('data', (chunk) => {
      if (stderrLen >= maxStderrBytes) {
        overflow = true;
        return;
      }
      const take = Math.min(chunk.length, maxStderrBytes - stderrLen);
      if (take < chunk.length) overflow = true;
      stderr.push(chunk.subarray(0, take));
      stderrLen += take;
    });

    child.on('error', (error) => {
      finish(rejectPromise, error);
    });
    child.on('close', (code, closeSignal) => {
      finish(resolvePromise, {
        code,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        overflow,
      });
    });
  });
}

/**
 * Resolve several glob patterns under one root, de-duplicating absolute paths.
 * Node's fs.glob excludes dotfiles; `hidden` adds the dot variants explicitly.
 */
export async function globPaths({ cwd, patterns, exclude = [], hidden = false, type = 'file' }) {
  const seen = new Set();
  const entries = [];
  const expanded = [...patterns];
  if (hidden) {
    for (const pattern of patterns) {
      const variant = dotVariant(pattern);
      if (variant !== undefined && !expanded.includes(variant)) expanded.push(variant);
      if (pattern.startsWith('**/')) {
        const contents = `**/.*/**`;
        if (!expanded.includes(contents)) expanded.push(contents);
      }
    }
  }

  for (const pattern of expanded) {
    for await (const entry of glob(pattern, { cwd, exclude, withFileTypes: true })) {
      const absolutePath = join(entry.parentPath ?? cwd, entry.name);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      entries.push({ absolutePath, entry });
    }
  }

  const filtered = [];
  for (const item of entries) {
    if (type === 'any') {
      filtered.push(item.absolutePath);
      continue;
    }
    let kind;
    try {
      const info = await stat(item.absolutePath);
      kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
    } catch {
      continue;
    }
    if (type === 'file' ? kind === 'file' : kind === 'dir') filtered.push(item.absolutePath);
  }
  return filtered;
}

/** Turn the last path segment into its dotfile variant (`src/*.ts` -> `src/.*.ts`). */
function dotVariant(pattern) {
  const slash = pattern.lastIndexOf('/');
  const head = slash >= 0 ? pattern.slice(0, slash + 1) : '';
  const tail = slash >= 0 ? pattern.slice(slash + 1) : pattern;
  if (tail === '' || tail.startsWith('.')) return undefined;
  return `${head}.${tail}`;
}

/** One-line error text for a rejected child process. */
export function describeSpawnError(toolName, file, error) {
  const code = error?.code;
  if (code === 'ENOENT') {
    return `${toolName}: required executable "${file}" was not found on PATH (Linux-only toolset)`;
  }
  return `${toolName}: failed to run ${file}: ${error instanceof Error ? error.message : String(error)}`;
}
