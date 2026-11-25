# DSP fork CI

同一 fork 内的 PR 会先在 Linux 上按合并差异选择检查。只有命中 PTC 或 Web 的改动才会申请 macOS 运行器。两个范围都命中时，在同一个作业里构建一次依赖的并集，再依次测试。

| 改动 | 验证 |
| --- | --- |
| PTC 运行时或 PTC 工作流 | 编译测试用到的 Host 包、真实插件及其依赖，运行相关单元测试和 Node/Bun 端到端测试。 |
| Web 启动入口、Web profile、前端或它们的依赖 | 编译 CLI、Web 插件和前端，检查热重载，并从真实 CLI 获取页面及其 JavaScript。 |
| 公共构建配置、原生模块或单独更新锁文件 | 运行两条路径。锁文件随某个运行时组件一起更新时，使用该组件的范围。 |
| 说明文档或无关应用 | 跳过 DSP 的 macOS 作业。 |

包的运行时依赖从 workspace manifest 读取。测试动态加载的插件由 `scope.mjs` 指定；新增这类插件时应同时更新根包。Host 和 Client 分别使用仓库已有的 TypeScript 项目及打包配置。Vitest 每次只使用一个 worker。

Python SDK、原生多平台矩阵和 npm 打包各自按相关路径触发；发版打包也可以在 Actions 页面手动运行。本工作流验证本仓库的 Web 入口，不构建外部的 Swift 应用。
