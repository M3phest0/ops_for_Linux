import { defineTool } from '@deepseek-ai/dsh-tools';
import { stat } from 'node:fs/promises';
import {
  clampInt,
  sessionCwd,
  displayPath,
  resolveFrom,
  shellQuote,
  tailBytes,
} from './util.js';

const BASH_MAX_OUTPUT_BYTES = 64 * 1024;

function renderBashResult(result, mode) {
  const parts = [];
  const stdout = tailBytes(result.stdout?.text ?? '', BASH_MAX_OUTPUT_BYTES);
  const stderr = tailBytes(result.stderr?.text ?? '', BASH_MAX_OUTPUT_BYTES);
  if (stdout.length > 0) parts.push(stdout.replace(/\n$/, ''));
  if (stderr.length > 0) parts.push(`[stderr]\n${stderr.replace(/\n$/, '')}`);
  if (result.stdout?.truncated === true || result.stderr?.truncated === true) {
    parts.push('[output truncated to the tail]');
  }
  if (result.sandbox?.runnerFailed === true) {
    parts.push(`[sandbox: the sandbox runner failed under ${result.sandbox.mode} mode — the command did not run]`);
  } else if (result.sandbox?.denied === true) {
    parts.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`);
  }
  if (result.aborted === true) parts.push('[aborted]');
  else if (result.timedOut === true) parts.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null && result.signal !== undefined) parts.push(`[signal: ${result.signal}]`);
  if (result.exitCode !== 0 && result.exitCode !== null) parts.push(`[exit code: ${result.exitCode}]`);
  if (parts.length === 0) parts.push('(no output)');
  if (mode === 'script') parts.unshift('[script]');
  return parts.join('\n');
}

export function registerBash(ctx, config) {
  const defaultTimeoutMs = clampInt(config.bashTimeoutMs, 1000, 600000, 120000);

  ctx.tools.register(defineTool({
    name: 'ops_bash',
    description: 'Run a foreground Linux bash command and return stdout, stderr and markers. Exactly one of command or script_path is required. Keep command short; for multi-line scripts write a file first and pass script_path, which avoids escaping a heredoc inside JSON. Each call gets a fresh shell; pass workdir instead of cd. The command runs under the session sandbox policy; this tool does not accept sandbox_permissions, so use the host bash tool when you need a wider sandbox. There is no run_in_background: use the host bash tool with run_in_background for servers and watchers.',
    parameters: {
      description: { type: 'string', required: true, description: 'Short active-voice description of the command (5-10 words).' },
      command: { type: 'string', description: 'Bash command text. Mutually exclusive with script_path.' },
      script_path: { type: 'string', description: 'Path to an existing script; executed as bash <path>. Mutually exclusive with command.' },
      workdir: { type: 'string', description: 'Working directory, relative to the session cwd by default.' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds. Default: 120000; capped at 600000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          exit_code: { type: 'integer' },
          cwd: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (args, value) => ({
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        ...(args.description === undefined ? {} : { description: args.description }),
      }),
    },
    timeoutMs: 600000 + 5000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec);
      const allowed = new Set(['description', 'command', 'script_path', 'workdir', 'timeout_ms']);
      const unknown = Object.keys(args).filter((key) => !allowed.has(key));
      if (unknown.length > 0) {
        throw new Error(`ops_bash: unknown argument(s) ${unknown.join(', ')}; accepted: ${[...allowed].join(', ')}`);
      }
      const hasCommand = typeof args.command === 'string' && args.command.trim().length > 0;
      const hasScript = typeof args.script_path === 'string' && args.script_path.trim().length > 0;
      if (hasCommand === hasScript) {
        throw new Error('ops_bash: provide exactly one of command or script_path');
      }
      const timeoutMs = clampInt(args.timeout_ms, 1000, 600000, defaultTimeoutMs);
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0 ? resolveFrom(cwd, args.workdir) : cwd;

      let command;
      let mode = 'command';
      if (hasScript) {
        mode = 'script';
        const scriptAbsolute = resolveFrom(workdir ?? cwd, args.script_path);
        try {
          const scriptInfo = await stat(scriptAbsolute);
          if (!scriptInfo.isFile()) throw new Error('not a regular file');
        } catch {
          throw new Error(`ops_bash: script_path does not exist or is not a regular file: ${args.script_path}`);
        }
        command = `bash ${shellQuote(scriptAbsolute)}`;
      } else {
        command = args.command;
      }

      if (ctx.shell === undefined) throw new Error('ops_bash: no shell executor is mounted in this composition');
      const sandboxMode = ctx.shell.sandboxMode;
      let sandboxPolicy;
      if (sandboxMode !== undefined) {
        const policy = ctx.get('sandboxPolicy');
        if (policy === undefined) throw new Error('ops_bash: the mounted shell confines commands but ctx.sandboxPolicy is missing');
        sandboxPolicy = policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
      }

      const shellEnv = ctx.get('shellEnv');
      const dshEnv = shellEnv !== undefined && typeof shellEnv.collect === 'function' ? shellEnv.collect(exec) : undefined;
      const spec = ctx.shell.resolve({
        command,
        workdir,
        timeoutMs,
        signal: exec.signal,
        ...(dshEnv === undefined ? {} : { dshEnv }),
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      });

      let result;
      try {
        result = await (await ctx.shell.execute(spec)).result();
      } catch (error) {
        throw new Error(`ops_bash: failed to run command: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.aborted === true) throw new Error('ops_bash: cancelled');
      return {
        text: renderBashResult(result, mode),
        ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
        cwd: displayPath(cwd, spec.workdir ?? workdir),
      };
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: (args.command ?? `bash ${args.script_path ?? ''}`).split('\n')[0].slice(0, 120),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.workdir === undefined ? {} : { cwd: args.workdir }),
    }),
  }));
}
