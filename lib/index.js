/**
 * dsh-linux-ops — Linux-native base operations toolset for DeepSeek Harness.
 *
 * dsh-ops targets Windows by bundling bash, PowerShell 7 and Rust FastCtx
 * binaries. Linux already ships bash and GNU userland, so this bundle keeps the
 * same positioning — a compact base layer that spends fewer tokens on file and
 * command operations — without bundling a shell or a native worker.
 *
 * Tools:
 * - ops_grep     compact multi-file content search (modes: content/files/count/summary)
 * - ops_glob     multi-pattern path discovery
 * - ops_inspect  batched ranged reads, hex dumps, metadata
 * - ops_replace  planned cross-file literal/regex replacement, sandbox-aware
 * - ops_bash     foreground bash runner with script_path (no JSON-escaped heredoc)
 *
 * @module dsh-linux-ops
 */
import z from '@deepseek-ai/schemastery';
import { registerGrep } from './grep.js';
import { registerGlob } from './glob.js';
import { registerInspect } from './inspect.js';
import { registerReplace } from './replace.js';
import { registerBash } from './bash.js';

export const name = 'dsh-linux-ops';
export const inject = ['tools'];

export const Config = z.object({
  enableFileTools: z.boolean().default(true),
  enableReplace: z.boolean().default(true),
  enableBashTool: z.boolean().default(true),
  promptPolicy: z.boolean().default(true),
  promptOrder: z.number().default(0),
  extraGuidance: z.string().default(''),
  grepTimeoutMs: z.number().default(30000),
  bashTimeoutMs: z.number().default(120000),
  maxGrepResults: z.number().default(200),
});

const DEFAULTS = Object.freeze({
  enableFileTools: true,
  enableReplace: true,
  enableBashTool: true,
  promptPolicy: true,
  promptOrder: 0,
  extraGuidance: '',
  grepTimeoutMs: 30000,
  bashTimeoutMs: 120000,
  maxGrepResults: 200,
});

/** Merge stored config over defaults; a missing row config stays usable. */
export function normalizeConfig(config) {
  const value = config !== null && typeof config === 'object' ? config : {};
  return {
    enableFileTools: value.enableFileTools ?? DEFAULTS.enableFileTools,
    enableReplace: value.enableReplace ?? DEFAULTS.enableReplace,
    enableBashTool: value.enableBashTool ?? DEFAULTS.enableBashTool,
    promptPolicy: value.promptPolicy ?? DEFAULTS.promptPolicy,
    promptOrder: typeof value.promptOrder === 'number' ? value.promptOrder : DEFAULTS.promptOrder,
    extraGuidance: typeof value.extraGuidance === 'string' ? value.extraGuidance : DEFAULTS.extraGuidance,
    grepTimeoutMs: typeof value.grepTimeoutMs === 'number' ? value.grepTimeoutMs : DEFAULTS.grepTimeoutMs,
    bashTimeoutMs: typeof value.bashTimeoutMs === 'number' ? value.bashTimeoutMs : DEFAULTS.bashTimeoutMs,
    maxGrepResults: typeof value.maxGrepResults === 'number' ? value.maxGrepResults : DEFAULTS.maxGrepResults,
  };
}

const USAGE = `## Linux ops toolset (dsh-linux-ops)
Prefer these compact Linux tools over ad-hoc find/grep pipelines:
- ops_glob: multi-pattern path discovery; skips .git, node_modules and common build directories by default.
- ops_grep: grouped content search with mode=content|files|count|summary; narrow with include/exclude_dirs.
- ops_inspect: one call reads ranged lines from several files, dumps hex for binary, or reports size/type/encoding.
- ops_replace: plan cross-file literal or regex replacement. It defaults to dry_run=true; review the counts and previews, then call again with dry_run=false. Use the host edit tool for one deliberate edit.
- ops_bash: foreground Linux bash. Keep command short; for multi-line scripts write a file first and pass script_path instead of escaping a heredoc in JSON. It has no run_in_background and no sandbox escalation: use the host bash tool for background servers or wider sandbox access.
Paths in results are relative to the session working directory. Raise max_results only for an intentionally broad search.`;

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);

  if (config.enableFileTools) {
    registerGrep(ctx, config);
    registerGlob(ctx, config);
    registerInspect(ctx, config);
    if (config.enableReplace) {
      ctx.inject?.(['fs'], (fsCtx) => {
        registerReplace(fsCtx, config);
      });
    }
  }

  if (config.enableBashTool) {
    ctx.inject?.(['shell'], (shellCtx) => {
      registerBash(shellCtx, config);
    });
  }

  if (config.promptPolicy) {
    ctx.inject?.(['systemPrompt'], (promptCtx) => {
      const autoOrder = typeof promptCtx.systemPrompt?.getSectionOrder === 'function'
        ? promptCtx.systemPrompt.getSectionOrder('TOOL_GREP') + 5
        : 1505;
      const order = config.promptOrder > 0 ? config.promptOrder : autoOrder;
      promptCtx.systemPrompt?.section({
        name: 'dsh-linux-ops:usage',
        order,
        text: config.extraGuidance.trim().length > 0
          ? `${USAGE}\n\n${config.extraGuidance.trim()}`
          : USAGE,
      });
    });
  }
}
