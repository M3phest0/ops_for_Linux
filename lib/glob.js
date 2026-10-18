import { defineTool } from '@deepseek-ai/dsh-tools';
import { stat } from 'node:fs/promises';
import {
  DEFAULT_EXCLUDES,
  clampInt,
  sessionCwd,
  displayPath,
  globPaths,
  resolveFrom,
} from './util.js';

const GLOB_MAX_RESULTS = 200;

export function registerGlob(ctx, config) {
  const timeoutMs = clampInt(config.grepTimeoutMs, 1000, 600000, 30000);
  ctx.tools.register(defineTool({
    name: 'ops_glob',
    description: 'Find paths with one or more glob patterns on Linux. Supports **, *, ?, [..] and {a,b}; excludes .git, node_modules and common build directories by default. Returns workspace-relative paths, sorted or ordered by mtime/size. Prefer this over find/ls pipelines when you need paths rather than content.',
    parameters: {
      patterns: { type: 'array', items: { type: 'string' }, required: true, description: 'One or more glob patterns relative to path (e.g. ["**/*.ts", "src/**/*.json"]).' },
      path: { type: 'string', description: 'Root directory. Default: session working directory.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Extra exclude globs, relative to path (e.g. ["**/fixtures/**"]).' },
      hidden: { type: 'boolean', description: 'Include dotfiles and dot-directories. Default: false.' },
      type: { type: 'string', enum: ['file', 'dir', 'any'], description: 'Entry type to return. Default: file.' },
      sort: { type: 'string', enum: ['path', 'mtime', 'size'], description: 'Ordering. Default: path. mtime is newest first; size is largest first.' },
      max_results: { type: 'integer', description: 'Cap on returned paths. Default: 200, maximum: 5000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec);
      const root = resolveFrom(cwd, args.path);
      const patterns = Array.isArray(args.patterns) ? args.patterns.filter((value) => typeof value === 'string' && value.length > 0) : [];
      if (patterns.length === 0) throw new Error('ops_glob: patterns must contain at least one non-empty glob');
      const maxResults = clampInt(args.max_results, 1, 5000, GLOB_MAX_RESULTS);
      let rootInfo;
      try {
        rootInfo = await stat(root);
      } catch {
        throw new Error(`ops_glob: path does not exist or is not readable: ${args.path ?? '.'}`);
      }
      if (!rootInfo.isDirectory()) throw new Error(`ops_glob: path must be a directory: ${args.path ?? '.'}`);
      const type = args.type ?? 'file';
      const excludes = [...DEFAULT_EXCLUDES.map((directory) => `**/${directory}/**`), ...(Array.isArray(args.exclude) ? args.exclude.filter((value) => typeof value === 'string' && value.length > 0) : [])];

      let matches;
      try {
        matches = await globPaths({ cwd: root, patterns, exclude: excludes, hidden: args.hidden === true, type });
      } catch (error) {
        throw new Error(`ops_glob: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (exec.signal.aborted) throw new Error('ops_glob: cancelled');

      const sort = args.sort ?? 'path';
      let ordered = [...matches];
      if (sort === 'mtime' || sort === 'size') {
        const withInfo = [];
        for (const absolutePath of ordered) {
          try {
            const info = await stat(absolutePath);
            withInfo.push({ absolutePath, value: sort === 'mtime' ? info.mtimeMs : info.size });
          } catch {
            // A path that vanished during the walk is simply omitted.
          }
        }
        withInfo.sort((a, b) => b.value - a.value || a.absolutePath.localeCompare(b.absolutePath));
        ordered = withInfo.map((item) => item.absolutePath);
      } else {
        ordered.sort((a, b) => a.localeCompare(b));
      }

      if (ordered.length === 0) return { text: 'No paths matched.', count: 0 };
      const visible = ordered.slice(0, maxResults);
      const lines = visible.map((absolutePath) => {
        const display = displayPath(cwd, absolutePath);
        return type === 'dir' ? `${display}/` : display;
      });
      if (visible.length < ordered.length) lines.push(`[showing ${visible.length} of ${ordered.length} paths]`);
      lines.push(`[${ordered.length} path${ordered.length === 1 ? '' : 's'}]`);
      return { text: lines.join('\n'), count: ordered.length };
    },
  }));
}
