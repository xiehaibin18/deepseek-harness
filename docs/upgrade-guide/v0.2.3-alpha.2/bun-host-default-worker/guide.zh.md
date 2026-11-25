---
kind: upgrade-guide
description: "在 macOS 上，Bun Web Host 默认选择 Bun PTC 子进程，这一选择独立于 DSP_NODE_EXECUTABLE。"
---
# Bun Web Host 默认启动 Bun PTC 子进程

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ptc-runtime-node` 过去需要 `DSP_NODE_EXECUTABLE` 才能在 Bun Web Host 上启动默认的 Node 子进程。现在，macOS 上默认的 `bun-script` 子进程使用运行 Host 的 Bun 可执行文件。即使部署中仍然设置了这个环境变量，PTC 选择子进程时也会忽略它。

## 迁移

1. 如果构建或启动工具仍在使用 `DSP_NODE_EXECUTABLE`，请保留它。DSP 从源码重新构建时，用这个变量定位 `pnpm` 并选择 Bun Host 的构建步骤。等这些工具可以自行定位工具链后，再移除该变量。
2. 确保 `@deepseek-ai/dsh-ptc-runtime-node` 能解析到 `amaro` 包。它是一个可选对等依赖：源码检出会随工作区一起安装；Node 运行时发布包不携带它，因为只有 Bun Host 用它擦除 TypeScript。
3. 如果部署依赖 `maxOldGenerationSizeMb`，请在 `ptc-runtime` 插件配置中将 `launch` 设为 `{ kind: node-script, executable: /path/to/node }`，继续使用 Node 子进程。只有 Node 子进程会执行这项 V8 堆内存限制。
4. 通过 PTC 运行一个返回 `typeof process.versions.bun` 的程序。默认子进程返回 `"string"`；显式选择的 Node 子进程返回 `"undefined"`。
