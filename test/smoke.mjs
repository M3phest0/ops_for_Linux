import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, normalizeConfig } from '../lib/index.js';
import { parseGrepContent, parseGrepCounts, parseGrepFiles } from '../lib/grep.js';
import { replaceLiteral, replaceRegex } from '../lib/replace.js';

const here = dirname(fileURLToPath(import.meta.url));

function fakeFs() {
  return {
    sandboxMode: undefined,
    async resolve(path) {
      return { targetKey: path, displayPath: path };
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey);
        return {
          version: { mtimeMs: info.mtimeMs, size: info.size },
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
        };
      } catch {
        return undefined;
      }
    },
    async readText(target) {
      return readFile(target.targetKey, 'utf8');
    },
    async writeText(target, content) {
      await writeFile(target.targetKey, content, 'utf8');
      return { operation: 'update', version: {}, before: null, after: content };
    },
  };
}

function fakeShell(cwd) {
  return {
    sandboxMode: undefined,
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? cwd,
        timeoutMs: request.timeoutMs ?? 120000,
        onExpiry: 'kill',
        stdoutMaxBytes: 1024 * 1024,
        signal: request.signal,
      };
    },
    async execute(spec) {
      const result = await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('bash', ['-c', spec.command], { cwd: spec.workdir, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        child.stdout.on('data', (chunk) => out.push(chunk));
        child.stderr.on('data', (chunk) => err.push(chunk));
        child.on('error', rejectPromise);
        child.on('close', (code, signal) => resolvePromise({ code, signal, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
      });
      return {
        async result() {
          return {
            exitCode: result.code,
            signal: result.signal,
            timedOut: false,
            aborted: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: result.out, truncated: false },
            stderr: { text: result.err, truncated: false },
          };
        },
      };
    },
  };
}

function buildContext(cwd) {
  const defs = new Map();
  const sections = [];
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(defs.has(definition.name), false, `duplicate tool ${definition.name}`);
        defs.set(definition.name, definition);
        return () => defs.delete(definition.name);
      },
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
      getSectionOrder() {
        return 1500;
      },
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    get(service) {
      if (service === 'fs') return ctx.fs;
      if (service === 'shell') return ctx.shell;
      if (service === 'systemPrompt') return ctx.systemPrompt;
      return undefined;
    },
    fs: fakeFs(),
    shell: fakeShell(cwd),
  };
  return { ctx, defs, sections };
}

async function call(defs, name, args, cwd) {
  const definition = defs.get(name);
  assert.ok(definition, `${name} is registered`);
  return definition.execute(args, {
    callId: `test-${name}`,
    name,
    arguments: args,
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('grep parsers handle NUL output', () => {
  const content = parseGrepContent('src/a.ts\u000012:const x = 1;\nsrc/a.ts\u000013-context\n');
  assert.deepEqual(content, [
    { path: 'src/a.ts', line: 12, kind: 'match', text: 'const x = 1;' },
    { path: 'src/a.ts', line: 13, kind: 'context', text: 'context' },
  ]);
  assert.deepEqual(parseGrepCounts('src/a.ts\u00002\nsrc/b.ts\u00000\n'), [{ path: 'src/a.ts', count: 2 }]);
  assert.deepEqual(parseGrepFiles('src/a.ts\u0000src/b.ts\u0000'), ['src/a.ts', 'src/b.ts']);
});

test('literal and regex replacement count matches', () => {
  assert.deepEqual(replaceLiteral('a old b old', 'old', 'new', false), { text: 'a new b new', count: 2, indices: [2, 8] });
  assert.equal(replaceRegex('a Old b old', 'old', 'new', true, false).count, 2);
  assert.equal(replaceRegex('a old b old', 'old', 'new', false, true).text, 'a new b old');
});

test('config defaults and overrides', () => {
  assert.equal(normalizeConfig({}).enableBashTool, true);
  assert.equal(normalizeConfig({ enableBashTool: false }).enableBashTool, false);
  assert.equal(normalizeConfig({ grepTimeoutMs: 1234 }).grepTimeoutMs, 1234);
});

test('registers the toolset and prompt section', async () => {
  const root = await mkdtemp(join(here, '.tmp-'));
  try {
    const { ctx, defs, sections } = buildContext(root);
    apply(ctx, {});
    assert.deepEqual([...defs.keys()].sort(), ['ops_bash', 'ops_glob', 'ops_grep', 'ops_inspect', 'ops_replace']);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'dsh-linux-ops:usage');
    assert.equal(sections[0].order, 1505);
    assert.match(sections[0].text, /ops_grep/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file tools work end to end', async () => {
  const root = await mkdtemp(join(here, '.tmp-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), "export const token = 'old';\nconst x = 1;\n", 'utf8');
    await writeFile(join(root, 'src', 'b.ts'), 'token old\n', 'utf8');
    await writeFile(join(root, 'docs', 'readme.md'), 'token old\n', 'utf8');
    await writeFile(join(root, 'node_modules', 'skip.js'), 'token old\n', 'utf8');
    await writeFile(join(root, '.hidden.ts'), 'token old\n', 'utf8');

    const { ctx, defs } = buildContext(root);
    apply(ctx, {});

    const globbed = await call(defs, 'ops_glob', { patterns: ['**/*.ts'] }, root);
    assert.match(globbed.text, /src\/a\.ts/);
    assert.match(globbed.text, /src\/b\.ts/);
    assert.doesNotMatch(globbed.text, /node_modules/);
    assert.doesNotMatch(globbed.text, /\.hidden/);

    const hidden = await call(defs, 'ops_glob', { patterns: ['**/*.ts'], hidden: true }, root);
    assert.match(hidden.text, /\.hidden\.ts/);

    const grepped = await call(defs, 'ops_grep', { pattern: 'old' }, root);
    assert.match(grepped.text, /src\/a\.ts:1:/);
    assert.match(grepped.text, /3 matches in 3 files/);
    assert.doesNotMatch(grepped.text, /node_modules/);

    const counts = await call(defs, 'ops_grep', { pattern: 'old', mode: 'count' }, root);
    assert.match(counts.text, /src\/a\.ts: 1/);
    assert.match(counts.text, /3 matches in 3 files/);

    const inspected = await call(defs, 'ops_inspect', { paths: ['src/a.ts'], offset: 1, limit: 1 }, root);
    assert.match(inspected.text, /1: export const token/);

    const dry = await call(defs, 'ops_replace', { path: 'src', pattern: 'old', replacement: 'new' }, root);
    assert.match(dry.text, /dry run: 2 replacements in 2 files/);
    assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), "export const token = 'old';\nconst x = 1;\n");

    const applied = await call(defs, 'ops_replace', { path: 'src', pattern: 'old', replacement: 'new', dry_run: false }, root);
    assert.match(applied.text, /applied: 2 replacements in 2 files/);
    assert.equal(applied.applied, true);
    assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), "export const token = 'new';\nconst x = 1;\n");
    assert.equal(await readFile(join(root, 'src', 'b.ts'), 'utf8'), 'token new\n');

    const regex = await call(defs, 'ops_replace', { path: 'src', pattern: "token = '(\\w+)'", replacement: 'token = "$1"', is_regex: true, dry_run: true }, root);
    assert.match(regex.text, /1 replacement in 1 file/);

    const bash = await call(defs, 'ops_bash', { description: 'Print a marker', command: "printf 'ok\\n'" }, root);
    assert.equal(bash.exit_code, 0);
    assert.match(bash.text, /ok/);

    await writeFile(join(root, 'script.sh'), '#!/usr/bin/env bash\necho script-ok\n', 'utf8');
    const scripted = await call(defs, 'ops_bash', { description: 'Run a script', script_path: 'script.sh' }, root);
    assert.equal(scripted.exit_code, 0);
    assert.match(scripted.text, /script-ok/);
    assert.match(scripted.text, /\[script\]/);

    await assert.rejects(
      () => call(defs, 'ops_bash', { description: 'Bad call', command: 'true', script_path: 'script.sh' }, root),
      /exactly one of command or script_path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('search modes, metadata and globs', async () => {
  const root = await mkdtemp(join(here, '.tmp-'));
  try {
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'alpha old\nbeta old\n', 'utf8');
    await writeFile(join(root, 'src', 'nested', 'b.ts'), 'gamma old\n', 'utf8');
    await writeFile(join(root, 'notes.md'), 'old\n', 'utf8');
    const { ctx, defs } = buildContext(root);
    apply(ctx, {});

    const files = await call(defs, 'ops_grep', { pattern: 'old', mode: 'files' }, root);
    assert.match(files.text, /src\/a\.ts/);
    assert.match(files.text, /src\/nested\/b\.ts/);
    assert.match(files.text, /3 files/);

    const summary = await call(defs, 'ops_grep', { pattern: 'old', mode: 'summary' }, root);
    assert.match(summary.text, /src: 3/);
    assert.match(summary.text, /^src: 3$/m);
    assert.match(summary.text, /4 matches in 3 files/);

    const meta = await call(defs, 'ops_inspect', { paths: ['src/a.ts'], mode: 'meta' }, root);
    assert.match(meta.text, /type: file/);
    assert.match(meta.text, /lines: 2/);

    const hex = await call(defs, 'ops_inspect', { paths: ['src/a.ts'], mode: 'hex', limit: 32 }, root);
    assert.match(hex.text, /^src\/a\.ts \(hex, offset 0\)\n00000000/m);

    const dirs = await call(defs, 'ops_glob', { patterns: ['**/*'], type: 'dir' }, root);
    assert.match(dirs.text, /src\//);
    assert.match(dirs.text, /src\/nested\//);

    await assert.rejects(
      () => call(defs, 'ops_replace', { path: 'src', pattern: 'old', replacement: 'new', ignore_case: true }, root),
      /ignore_case requires is_regex=true/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} test(s) passed`);
}
