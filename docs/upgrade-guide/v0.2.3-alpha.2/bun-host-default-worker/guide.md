---
kind: upgrade-guide
description: "A Web Host that runs on Bun starts its PTC worker with Bun by default and no longer reads DSP_NODE_EXECUTABLE."
---
# A Bun Web Host starts a Bun PTC worker by default

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ptc-runtime-node` started its default `node-script` worker on a Bun Web Host only when `DSP_NODE_EXECUTABLE` named a Node executable, and failed to load without it. On macOS, a Bun Web Host now starts the default worker as `bun-script` with the Bun executable that runs the Host, and `DSP_NODE_EXECUTABLE` is no longer read. Every Web Host started with Bun observes the change, including deployments that set `DSP_NODE_EXECUTABLE`.

## Migration

1. Remove `DSP_NODE_EXECUTABLE` from the environment of a Bun Web Host.
2. Make the `amaro` package resolvable from `@deepseek-ai/dsh-ptc-runtime-node`. It is an optional peer dependency: a source checkout installs it with the workspace, and a Node runtime bundle omits it because only a Bun Host strips TypeScript with it.
3. To keep Node workers, set `launch` in the `ptc-runtime` plugin configuration: `{ kind: node-script, executable: /path/to/node }`.
4. Run a program through PTC that returns `typeof process.versions.bun`. The default worker returns `"string"`; a selected Node worker returns `"undefined"`.
