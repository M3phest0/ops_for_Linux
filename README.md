# dsh-linux-ops

Linux-native base operations toolset for **DeepSeek Harness (DSH)** — the Linux
counterpart to [`dsh-ops`](https://www.npmjs.com/package/dsh-ops)' *positioning*,
not a port of its Windows payloads.

`dsh-ops` exists because Windows needs a bundled bash, PowerShell 7 and Rust
FastCtx binaries. Linux already ships bash and a competent GNU userland, so
this bundle keeps the useful part — **fewer tokens and fewer round trips for
file and command operations** — without shipping a shell, a native worker, or
an install script.

## Tools

| Tool | What it does | Why it saves tokens |
| --- | --- | --- |
| `ops_grep` | GNU grep search with `content`, `files`, `count`, `summary` modes; include/exclude filters; hidden off by default | One compact call replaces `grep`/`find`/`wc` pipelines and many repeated reads |
| `ops_glob` | One or many glob patterns, exclude globs, mtime/size ordering | Multi-pattern discovery without `find` chaining |
| `ops_inspect` | Batched ranged reads, hex dump, metadata (size/mode/mtime/encoding/lines) | One call reads several files and reports binary before wasting tokens |
| `ops_replace` | Cross-file literal/regex replacement with dry-run previews | Plan and verify before writing; no per-file edit loop |
| `ops_bash` | Foreground Linux bash with `command` **or** `script_path` | `script_path` keeps multi-line scripts out of JSON escaping; strict schema rejects stray `run_in_background` |

All tools resolve the session's **effective** working directory, including a
change made through the `working_directory` tool. The plugin also contributes
one short system-prompt section that tells the model when to prefer these tools
over ad-hoc shell pipelines.

## Install

From this checkout:

```console
dsh plugin --profile web add /absolute/path/to/dsh-linux-ops
# or install the packed tarball:
dsh plugin --profile web add /absolute/path/to/dsh-linux-ops-0.1.0.tgz
```

Or install the directory through the Web Plugin Manager / market bundle
installer. The bundle patch mounts one row; components can be disabled in its
`config`.

Requirements: Linux, Node `^22.19.0 || >=24`, a working `grep` on `PATH`.
`grep` is the only external executable used.

## Configuration

Edit the `dsh-linux-ops` row in `cordis.patch.yml` (or the profile overlay):

```yaml
- id: dsh-linux-ops
  config:
    enableFileTools: true      # ops_grep / ops_glob / ops_inspect
    enableReplace: true        # ops_replace (also needs enableFileTools)
    enableBashTool: true       # ops_bash (registers when ctx.shell is mounted)
    promptPolicy: true         # add the usage section to the system prompt
    promptOrder: 0             # 0 = TOOL_GREP + 5
    extraGuidance: ''          # appended to the usage section
    grepTimeoutMs: 30000       # ops_grep / ops_glob / ops_inspect timeout
    bashTimeoutMs: 120000      # default ops_bash timeout, capped at 600000
    maxGrepResults: 200        # default ops_grep max_results
```

## Sandbox behavior

- `ops_replace` reads and writes through `ctx.fs`, so the mounted sandboxed
  filesystem enforces `workspace-write` / `read-only` policy. It writes with a
  version-checked intent, so a file that changed since the scan is rejected
  instead of overwritten.
- `ops_bash` resolves the session sandbox policy and passes it to the shell
  executor. It intentionally exposes **no** `sandbox_permissions` escalation:
  use the host `bash` tool when wider access is genuinely needed.
- `ops_bash` is foreground-only. Use the host `bash` tool with
  `run_in_background` for servers, watchers and long jobs.
- `ops_grep` / `ops_glob` / `ops_inspect` are read-only and marked
  concurrency-safe.

## Differences from dsh-ops

- No bundled bash or PowerShell 7; Linux bash is used.
- No Rust/FastCtx worker; search uses GNU grep and Node's built-in `fs.glob`.
- No PTC batch component and no separate background component: DSH already
  ships `run_code`, `bash` background jobs and `job_*` controls.
- No `ops_inspect_local_file` PDF text extraction; text/hex/metadata only.

## Development

```console
cd dsh-linux-ops
node test/smoke.mjs
```

The smoke test builds a fake Cordis context, registers the toolset, and
exercises all five tools against a temporary directory. For local imports it
needs temporary symlinks to `@deepseek-ai/dsh-tools` and
`@deepseek-ai/schemastery`; the installed profile resolves both through DSH's
package routing.

`install_bundle` links a local directory (`source: link:...`). After editing the
linked source, toggle the plugin row off/on in Plugin Manager (or restart DSH)
to load a fresh module generation.

## License

MIT.
