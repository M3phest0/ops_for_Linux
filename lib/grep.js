import { defineTool } from '@deepseek-ai/dsh-tools';
import { dirname, basename, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  DEFAULT_EXCLUDES,
  clampInt,
  sessionCwd,
  describeSpawnError,
  displayPath,
  resolveFrom,
  runCollect,
  shorten,
} from './util.js';

const GREP_MAX_RESULTS = 200;
const GREP_MAX_BYTES = 8 * 1024 * 1024;

/** Parse GNU grep's `-Z` content output (`path\0line:text`). */
export function parseGrepContent(stdout) {
  const entries = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '' || rawLine === '--') continue;
    const nul = rawLine.indexOf('\0');
    if (nul < 0) continue;
    const path = rawLine.slice(0, nul);
    const rest = rawLine.slice(nul + 1);
    const separator = rest.search(/[:-]/);
    if (separator < 0) continue;
    const line = Number.parseInt(rest.slice(0, separator), 10);
    if (!Number.isFinite(line)) continue;
    entries.push({
      path,
      line,
      kind: rest[separator] === ':' ? 'match' : 'context',
      text: rest.slice(separator + 1),
    });
  }
  return entries;
}

/** Parse `grep -cZ` output (`path\0count`). */
export function parseGrepCounts(stdout) {
  const counts = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue;
    const nul = rawLine.indexOf('\0');
    if (nul < 0) continue;
    const count = Number.parseInt(rawLine.slice(nul + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    counts.push({ path: rawLine.slice(0, nul), count });
  }
  return counts;
}

/** Parse `grep -lZ` output. */
export function parseGrepFiles(stdout) {
  return stdout
    .split('\0')
    .map((value) => value.replace(/\n+$/, ''))
    .filter((value) => value.length > 0);
}

function parsePath(display, runCwd, cwd) {
  const relativePath = display.replace(/^\.\//, '');
  return displayPath(cwd, resolve(runCwd, relativePath));
}

function formatContent(entries, { cwd, runCwd, maxResults, maxLineChars, overflow }) {
  if (entries.length === 0) return { text: '', matches: 0, files: 0 };
  const sorted = [...entries].sort((a, b) => {
    const pathCompare = parsePath(a.path, runCwd, cwd).localeCompare(parsePath(b.path, runCwd, cwd));
    return pathCompare !== 0 ? pathCompare : a.line - b.line;
  });
  const matchTotal = sorted.filter((entry) => entry.kind === 'match').length;
  const fileTotal = new Set(sorted.map((entry) => entry.path)).size;
  const visible = sorted.slice(0, maxResults);
  const lines = visible.map((entry) => {
    const path = parsePath(entry.path, runCwd, cwd);
    const marker = entry.kind === 'match' ? ':' : '-';
    return `${path}${marker}${entry.line}${entry.kind === 'match' ? ':' : '-'} ${shorten(entry.text, maxLineChars)}`;
  });
  if (visible.length < sorted.length) {
    lines.push(`[showing ${visible.length} of ${sorted.length} result lines]`);
  }
  if (overflow) lines.push('[grep output was truncated at the transport cap]');
  lines.push(`[${matchTotal} match${matchTotal === 1 ? '' : 'es'} in ${fileTotal} file${fileTotal === 1 ? '' : 's'}]`);
  return { text: lines.join('\n'), matches: matchTotal, files: fileTotal };
}

function formatCounts(counts, { cwd, runCwd, maxResults, overflow }) {
  if (counts.length === 0) return { text: '', matches: 0, files: 0 };
  const sorted = [...counts].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const total = sorted.reduce((sum, item) => sum + item.count, 0);
  const visible = sorted.slice(0, maxResults);
  const lines = visible.map((item) => `${parsePath(item.path, runCwd, cwd)}: ${item.count}`);
  if (visible.length < sorted.length) lines.push(`[showing ${visible.length} of ${sorted.length} files]`);
  if (overflow) lines.push('[grep output was truncated at the transport cap]');
  lines.push(`[${total} match${total === 1 ? '' : 'es'} in ${sorted.length} file${sorted.length === 1 ? '' : 's'}]`);
  return { text: lines.join('\n'), matches: total, files: sorted.length };
}

function formatSummary(counts, { cwd, runCwd, maxResults, overflow }) {
  if (counts.length === 0) return { text: '', matches: 0, files: 0 };
  const groups = new Map();
  let total = 0;
  for (const item of counts) {
    const path = parsePath(item.path, runCwd, cwd);
    const slash = path.indexOf('/');
    const group = slash < 0 ? '.' : path.slice(0, slash);
    groups.set(group, (groups.get(group) ?? 0) + item.count);
    total += item.count;
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const visible = sorted.slice(0, maxResults);
  const lines = visible.map(([group, count]) => `${group}: ${count}`);
  if (visible.length < sorted.length) lines.push(`[showing ${visible.length} of ${sorted.length} directories]`);
  if (overflow) lines.push('[grep output was truncated at the transport cap]');
  lines.push(`[${total} match${total === 1 ? '' : 'es'} in ${counts.length} file${counts.length === 1 ? '' : 's'}]`);
  return { text: lines.join('\n'), matches: total, files: counts.length };
}

export function registerGrep(ctx, config) {
  const defaultMaxResults = clampInt(config.maxGrepResults, 1, 5000, GREP_MAX_RESULTS);
  const timeoutMs = clampInt(config.grepTimeoutMs, 1000, 600000, 30000);

  ctx.tools.register(defineTool({
    name: 'ops_grep',
    description: 'Search file contents with GNU grep on Linux. Patterns are POSIX extended regular expressions unless fixed=true. Returns compact results grouped as path:line:text; select mode=files for paths only, mode=count for per-file counts, or mode=summary for per-directory totals. Skips .git, node_modules, hidden files and common build directories by default. Prefer this over shelling out to grep/find pipelines.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'POSIX extended regular expression, or a literal string when fixed=true.' },
      path: { type: 'string', description: 'File or directory to search. Default: session working directory.' },
      include: { type: 'array', items: { type: 'string' }, description: 'Only search files whose names match one of these globs (e.g. "*.ts"). Multiple entries are OR-ed.' },
      exclude_dirs: { type: 'array', items: { type: 'string' }, description: 'Extra directory names to skip, appended to the defaults.' },
      mode: { type: 'string', enum: ['content', 'files', 'count', 'summary'], description: 'Result shape. Default: content.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive matching.' },
      fixed: { type: 'boolean', description: 'Treat pattern as a fixed string instead of a regular expression.' },
      word: { type: 'boolean', description: 'Match whole words only.' },
      context: { type: 'integer', description: 'Show this many context lines around each match (0-10). Default: 0.' },
      hidden: { type: 'boolean', description: 'Include hidden files and directories. Default: false.' },
      max_results: { type: 'integer', description: 'Cap on returned result lines (content), files, or directories. Default: 200.' },
      max_line_chars: { type: 'integer', description: 'Trim each returned line to this many characters; 0 disables trimming. Default: 400.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          matches: { type: 'integer' },
          files: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        throw new Error('ops_grep: pattern must be a non-empty string');
      }
      const cwd = await sessionCwd(ctx, exec);
      const target = resolveFrom(cwd, args.path);
      let info;
      try {
        info = await stat(target);
      } catch {
        throw new Error(`ops_grep: path does not exist or is not readable: ${args.path ?? '.'}`);
      }
      const runCwd = info.isDirectory() ? target : dirname(target);
      const searchTarget = info.isDirectory() ? '.' : basename(target);

      const mode = args.mode ?? 'content';
      const maxResults = clampInt(args.max_results, 1, 5000, defaultMaxResults);
      const maxLineChars = clampInt(args.max_line_chars, 0, 4000, 400);
      const context = clampInt(args.context, 0, 10, 0);
      const include = Array.isArray(args.include) ? args.include.filter((value) => typeof value === 'string' && value.length > 0) : [];
      const extraExcludes = Array.isArray(args.exclude_dirs) ? args.exclude_dirs.filter((value) => typeof value === 'string' && value.length > 0) : [];
      const excludes = [...new Set([...DEFAULT_EXCLUDES, ...extraExcludes])];

      const grepArgs = ['--color=never', '-r', '-I', '-H', '-Z'];
      if (mode === 'files') grepArgs.push('-l');
      else if (mode === 'count' || mode === 'summary') grepArgs.push('-c');
      else grepArgs.push('-n');
      if (args.fixed === true) grepArgs.push('-F');
      else grepArgs.push('-E');
      if (args.ignore_case === true) grepArgs.push('-i');
      if (args.word === true) grepArgs.push('-w');
      if (context > 0 && mode === 'content') grepArgs.push('-C', String(context));
      for (const pattern of include) grepArgs.push(`--include=${pattern}`);
      for (const directory of excludes) grepArgs.push(`--exclude-dir=${directory}`);
      if (args.hidden !== true) {
        grepArgs.push('--exclude=.*', '--exclude-dir=.[!.]*', '--exclude-dir=..?*');
      }
      grepArgs.push('-e', args.pattern, '--', searchTarget);

      let result;
      try {
        result = await runCollect('grep', grepArgs, {
          cwd: runCwd,
          signal: exec.signal,
          timeoutMs,
          maxStdoutBytes: GREP_MAX_BYTES,
        });
      } catch (error) {
        throw new Error(describeSpawnError('ops_grep', 'grep', error));
      }
      if (exec.signal.aborted) throw new Error('ops_grep: cancelled');
      if (result.timedOut) throw new Error(`ops_grep: timed out after ${timeoutMs}ms; narrow the path or pattern`);
      if (result.code === 2) {
        const detail = result.stderr.trim() || 'unknown grep error';
        throw new Error(`ops_grep: ${detail}`);
      }
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`ops_grep: grep exited with ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
      }

      if (result.code === 1) {
        return { text: `No matches for ${args.fixed === true ? JSON.stringify(args.pattern) : `/${args.pattern}/`} in ${displayPath(cwd, target)}.`, matches: 0, files: 0 };
      }

      if (mode === 'files') {
        const files = parseGrepFiles(result.stdout).map((path) => parsePath(path, runCwd, cwd));
        const unique = [...new Set(files)].sort();
        const visible = unique.slice(0, maxResults);
        const lines = [...visible];
        if (visible.length < unique.length) lines.push(`[showing ${visible.length} of ${unique.length} files]`);
        if (result.overflow) lines.push('[grep output was truncated at the transport cap]');
        lines.push(`[${unique.length} file${unique.length === 1 ? '' : 's'}]`);
        return { text: lines.join('\n'), matches: unique.length, files: unique.length };
      }
      if (mode === 'count' || mode === 'summary') {
        const counts = parseGrepCounts(result.stdout);
        const formatted = mode === 'count'
          ? formatCounts(counts, { cwd, runCwd, maxResults, overflow: result.overflow })
          : formatSummary(counts, { cwd, runCwd, maxResults, overflow: result.overflow });
        return { text: formatted.text || 'No matches.', matches: formatted.matches, files: formatted.files };
      }

      const entries = parseGrepContent(result.stdout);
      const formatted = formatContent(entries, { cwd, runCwd, maxResults, maxLineChars, overflow: result.overflow });
      return { text: formatted.text || 'No matches.', matches: formatted.matches, files: formatted.files };
    },
  }));
}
