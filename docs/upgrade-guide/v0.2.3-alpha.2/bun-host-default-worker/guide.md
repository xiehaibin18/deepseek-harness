---
kind: upgrade-guide
description: "On macOS, a Bun Web Host selects a Bun PTC worker by default, independently of DSP_NODE_EXECUTABLE."
---
# A Bun Web Host starts a Bun PTC worker by default

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ptc-runtime-node` previously required `DSP_NODE_EXECUTABLE` to start its default Node worker on a Bun Web Host. On macOS, the default `bun-script` worker now uses the Bun executable that runs the Host. PTC ignores the environment variable when selecting a worker, including on deployments that still set it.

## Migration

1. Keep `DSP_NODE_EXECUTABLE` if your build or launch tools use it. The DSP source rebuild uses it to locate `pnpm` and select the Bun Host build steps. You can remove it once those tools locate their toolchain independently.
2. Make the `amaro` package resolvable from `@deepseek-ai/dsh-ptc-runtime-node`. It is an optional peer dependency: a source checkout installs it with the workspace, and a Node runtime bundle omits it because only a Bun Host strips TypeScript with it.
3. If you rely on `maxOldGenerationSizeMb`, keep Node workers by setting `launch` to `{ kind: node-script, executable: /path/to/node }` in the `ptc-runtime` plugin configuration. Only Node workers enforce this V8 heap limit.
4. Run a program through PTC that returns `typeof process.versions.bun`. The default worker returns `"string"`; a selected Node worker returns `"undefined"`.
