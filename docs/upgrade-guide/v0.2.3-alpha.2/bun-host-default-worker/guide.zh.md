---
kind: upgrade-guide
description: "运行在 Bun 上的 Web Host 默认用 Bun 启动 PTC 子进程，不再读取 DSP_NODE_EXECUTABLE。"
---
# Bun Web Host 默认启动 Bun PTC 子进程

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ptc-runtime-node` 过去只在 `DSP_NODE_EXECUTABLE` 指定 Node 可执行文件时，才在 Bun Web Host 上启动默认的 `node-script` 子进程，否则加载失败。现在，macOS 上的 Bun Web Host 用运行 Host 的 Bun 可执行文件以 `bun-script` 启动默认子进程，并且不再读取 `DSP_NODE_EXECUTABLE`。所有用 Bun 启动的 Web Host 都会观察到这一变化，包括设置了 `DSP_NODE_EXECUTABLE` 的部署。

## 迁移

1. 从 Bun Web Host 的环境中移除 `DSP_NODE_EXECUTABLE`。
2. 确保 `@deepseek-ai/dsh-ptc-runtime-node` 能解析到 `amaro` 包。它是一个可选对等依赖：源码检出会随工作区一起安装；Node 运行时发布包不携带它，因为只有 Bun Host 用它擦除 TypeScript。
3. 要继续使用 Node 子进程，请在 `ptc-runtime` 插件配置中设置 `launch`：`{ kind: node-script, executable: /path/to/node }`。
4. 通过 PTC 运行一个返回 `typeof process.versions.bun` 的程序。默认子进程返回 `"string"`；显式选择的 Node 子进程返回 `"undefined"`。
