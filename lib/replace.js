import { defineTool } from '@deepseek-ai/dsh-tools';
import { stat } from 'node:fs/promises';
import {
  DEFAULT_EXCLUDES,
  clampInt,
  sessionCwd,
  displayPath,
  globPaths,
  lineOfIndex,
  resolveFrom,
  shorten,
} from './util.js';

const REPLACE_MAX_FILES = 200;
const REPLACE_MAX_MATCHES = 2000;
const REPLACE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Literal replacement with match indices. */
export function replaceLiteral(text, pattern, replacement, firstOnly) {
  if (pattern.length === 0) throw new Error('ops_replace: pattern must be non-empty');
  const indices = [];
  let output = '';
  let cursor = 0;
  let index = text.indexOf(pattern);
  while (index >= 0) {
    indices.push(index);
    output += text.slice(cursor, index) + replacement;
    cursor = index + pattern.length;
    if (firstOnly) break;
    index = text.indexOf(pattern, cursor);
  }
  output += text.slice(cursor);
  return { text: output, count: indices.length, indices };
}

/** Regular-expression replacement with match indices. */
export function replaceRegex(text, pattern, replacement, ignoreCase, firstOnly) {
  if (pattern.length === 0) throw new Error('ops_replace: pattern must be non-empty');
  let expression;
  try {
    expression = new RegExp(pattern, `${firstOnly ? '' : 'g'}${ignoreCase ? 'i' : ''}`);
  } catch (error) {
    throw new Error(`ops_replace: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const indices = [];
  if (firstOnly) {
    const match = expression.exec(text);
    if (match !== null) indices.push(match.index);
  } else {
    for (const match of text.matchAll(expression)) {
      if (match.index === undefined) continue;
      indices.push(match.index);
    }
  }
  const output = text.replace(expression, replacement);
  return { text: output, count: indices.length, indices };
}

function previewLines(before, after, indices, limit = 3) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines = [];
  const seen = new Set();
  for (const index of indices) {
    if (lines.length >= limit) break;
    const lineNumber = lineOfIndex(before, index);
    if (seen.has(lineNumber)) continue;
    seen.add(lineNumber);
    const oldLine = beforeLines[lineNumber - 1] ?? '';
    const newLine = afterLines[lineNumber - 1] ?? '';
    if (oldLine === newLine) continue;
    lines.push(`  ${lineNumber}: - ${shorten(oldLine, 240)}`);
    lines.push(`  ${lineNumber}: + ${shorten(newLine, 240)}`);
  }
  return lines;
}

async function sandboxPolicyFor(ctx, exec) {
  if (ctx.fs === undefined) throw new Error('ops_replace: the filesystem service is unavailable');
  if (ctx.fs.sandboxMode === undefined) return undefined;
  const policy = ctx.get('sandboxPolicy');
  if (policy === undefined) throw new Error('ops_replace: the mounted filesystem confines writes but ctx.sandboxPolicy is missing');
  return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
}

export function registerReplace(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'ops_replace',
    description: 'Plan and apply literal or regular-expression replacements across one or more files on Linux. Defaults to dry_run=true and reports per-file counts plus short old/new previews; call again with dry_run=false to write. Writes go through the DSH filesystem service and therefore respect workspace-write sandbox policy. Use the host edit tool for a single deliberate edit.',
    parameters: {
      path: { type: 'string', required: true, description: 'File, or directory to scan recursively.' },
      pattern: { type: 'string', required: true, description: 'Literal text (default) or regular expression when is_regex=true.' },
      replacement: { type: 'string', required: true, description: 'Replacement text. Regex replacements may use $1, $& as usual.' },
      is_regex: { type: 'boolean', description: 'Interpret pattern as a JavaScript regular expression. Default: false.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive matching (regular expressions only).' },
      first_only: { type: 'boolean', description: 'Replace only the first match in each file. Default: false (all matches).' },
      include: { type: 'array', items: { type: 'string' }, description: 'When path is a directory, only scan files matching these globs (e.g. ["**/*.ts"]). Default: all files.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Extra exclude globs relative to path.' },
      dry_run: { type: 'boolean', description: 'Preview only. Default: true; set false to write changes.' },
      max_files: { type: 'integer', description: 'Maximum files to scan. Default: 200.' },
      max_matches: { type: 'integer', description: 'Maximum replacements per run. Default: 2000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          applied: { type: 'boolean' },
          files: { type: 'integer' },
          replacements: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec);
      const root = resolveFrom(cwd, args.path);
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        throw new Error('ops_replace: pattern must be a non-empty string');
      }
      const dryRun = args.dry_run !== false;
      const maxFiles = clampInt(args.max_files, 1, 2000, REPLACE_MAX_FILES);
      const maxMatches = clampInt(args.max_matches, 1, 20000, REPLACE_MAX_MATCHES);
      const firstOnly = args.first_only === true;
      if (args.ignore_case === true && args.is_regex !== true) {
        throw new Error('ops_replace: ignore_case requires is_regex=true');
      }

      let rootInfo;
      try {
        rootInfo = await stat(root);
      } catch {
        throw new Error(`ops_replace: path does not exist or is not readable: ${args.path}`);
      }

      let files;
      let discoveryNote = '';
      if (rootInfo.isFile()) {
        files = [root];
      } else if (rootInfo.isDirectory()) {
        const include = Array.isArray(args.include) && args.include.length > 0
          ? args.include.filter((value) => typeof value === 'string' && value.length > 0)
          : ['**/*'];
        const excludes = [
          ...DEFAULT_EXCLUDES.map((directory) => `**/${directory}/**`),
          ...(Array.isArray(args.exclude) ? args.exclude.filter((value) => typeof value === 'string' && value.length > 0) : []),
        ];
        files = await globPaths({ cwd: root, patterns: include, exclude: excludes, type: 'file' });
        files.sort((a, b) => a.localeCompare(b));
        if (files.length > maxFiles) {
          discoveryNote = `[scan limited to ${maxFiles} of ${files.length} files]`;
          files = files.slice(0, maxFiles);
        }
      } else {
        throw new Error(`ops_replace: not a regular file or directory: ${args.path}`);
      }

      const policy = dryRun ? undefined : await sandboxPolicyFor(ctx, exec);
      const reports = [];
      const previews = [];
      let totalReplacements = 0;
      let changedFiles = 0;
      let errorCount = 0;
      let limitReached = false;

      for (const absolutePath of files) {
        if (exec.signal.aborted) throw new Error('ops_replace: cancelled');
        if (totalReplacements >= maxMatches) {
          limitReached = true;
          break;
        }
        const display = displayPath(cwd, absolutePath);
        let target;
        let info;
        let before;
        try {
          target = await ctx.fs.resolve(absolutePath, { cwd, signal: exec.signal });
          info = await ctx.fs.stat(target, exec.signal);
          if (info === undefined || info.type !== 'file') continue;
          if (info.size !== undefined && info.size > REPLACE_MAX_FILE_BYTES) {
            reports.push(`${display}: skipped (${info.size} bytes > ${REPLACE_MAX_FILE_BYTES} cap)`);
            continue;
          }
          before = await ctx.fs.readText(target, exec.signal);
        } catch (error) {
          reports.push(`${display}: ERROR ${error instanceof Error ? error.message : String(error)}`);
          errorCount += 1;
          continue;
        }

        if (before.includes('\0')) {
          reports.push(`${display}: skipped (binary file)`);
          continue;
        }

        let result;
        try {
          result = args.is_regex === true
            ? replaceRegex(before, args.pattern, args.replacement, args.ignore_case === true, firstOnly)
            : replaceLiteral(before, args.pattern, args.replacement, firstOnly);
        } catch (error) {
          throw error;
        }
        if (result.count === 0) continue;
        const remaining = maxMatches - totalReplacements;
        if (result.count > remaining) {
          reports.push(`${display}: ${remaining} of ${result.count} matches would be applied (max_matches reached)`);
          limitReached = true;
          break;
        }

        totalReplacements += result.count;
        changedFiles += 1;
        reports.push(`${display}: ${result.count} replacement${result.count === 1 ? '' : 's'}`);
        previews.push(...previewLines(before, result.text, result.indices));

        if (!dryRun && result.text !== before) {
          try {
            await ctx.fs.writeText(
              target,
              result.text,
              { kind: 'replaceIfVersion', version: info.version },
              exec.signal,
              policy,
            );
          } catch (error) {
            reports.push(`${display}: WRITE FAILED ${error instanceof Error ? error.message : String(error)}`);
            errorCount += 1;
            totalReplacements -= result.count;
            changedFiles -= 1;
          }
        }
      }

      if (changedFiles === 0 && errorCount === 0) {
        return { text: `No matches for ${args.is_regex === true ? `/${args.pattern}/` : JSON.stringify(args.pattern)} in ${displayPath(cwd, root)}.`, applied: false, files: 0, replacements: 0 };
      }

      const header = dryRun
        ? `ops_replace dry run: ${totalReplacements} replacement${totalReplacements === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}`
        : `ops_replace applied: ${totalReplacements} replacement${totalReplacements === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}`;
      const lines = [header, ...reports];
      if (previews.length > 0) {
        lines.push('preview:');
        lines.push(...previews.slice(0, 12));
        if (previews.length > 12) lines.push('  … more changes omitted');
      }
      if (discoveryNote) lines.push(discoveryNote);
      if (limitReached) lines.push('[limit reached; raise max_matches/max_files or narrow the scan]');
      if (dryRun) lines.push('(Apply by calling again with dry_run=false.)');
      if (!dryRun && errorCount > 0) lines.push('[partial apply: some files failed; review WRITE FAILED lines]');
      return {
        text: lines.join('\n'),
        applied: !dryRun,
        files: changedFiles,
        replacements: totalReplacements,
      };
    },
  }));
}
