# 架构优化阶段一：主进程解耦与职责划分（SRP 重构）

本方案针对主进程的 `SSHManager` 进行单一职责重构，将其拆解为会话管理、系统监控、以及 SFTP 传输三个高内聚的服务。

## 用户审核与确认

> [!IMPORTANT]
> **无破坏性变更**：本次重构仅发生在主进程内部实现中，对外暴露给渲染进程的 IPC 接口契约完全保持不变。因此，前端 React 代码无需任何改动，能最大程度保证系统稳定性。
>
> **避免循环依赖**：在拆分时，新的子服务（`telemetryService` 和 `sftpService`）将仅通过 TypeScript `import type` 引入主进程的 `Session` 结构，确保运行时不会产生模块循环加载的问题。

## 拟定变更文件

我们将把 `src/main/sshManager.ts` 中的逻辑拆分至独立的两个子服务中，并精简 `sshManager.ts`。

---

### [NEW] `src/main/services/telemetryService.ts`

创建系统指标采集与解析子服务。
* **主要迁移内容**：
  * 命令常量 `MONITOR_CMD` 与 `SYSINFO_CMD`
  * 指标解析纯函数：`parseMonitorOutput`、`splitSections`、`parseMeminfo`、`parseNetDev`、`parseDf`、`parseProcs`、`parseSysInfo`
  * 轮询采集逻辑：`startMonitor(session, send)` 和 `fetchSysInfo(session, send)`

---

### [NEW] `src/main/services/sftpService.ts`

创建 SFTP 文件管理与上传下载子服务。
* **主要迁移内容**：
  * 基础工具：`logToFile` 写入 `sftp_upload.log`
  * SFTP 包装层获取：`getSftp(session)`
  * SFTP 目录操作：`sftpList`、`sftpMkdir`、`sftpRename`、`sftpRemove`、`sftpChmod`
  * 文件传输操作：`sftpDownload`、`sftpUpload`（包含目录递归上传 `uploadDir`）

---

### [MODIFY] `src/main/sshManager.ts`

精简为会话连接调度器，仅保留：
* `SSHManager` 类定义与 `sessions` 映射。
* 终端 Shell 的连接创建 `open()`、键入 `write()`、重置尺寸 `resize()`、断开 `close()`。
* **委托机制**：
  * 将 `sftp*` 相关的 IPC 请求直接委托给 `sftpService` 中的对应方法。
  * 在 `open` 连接就绪后，调用 `telemetryService` 启动监控和系统信息查询。

---

## 验证计划

本阶段优化属于重构，需要确保重构前后应用行为 100% 一致。

### 自动化测试
* 运行 TypeScript 类型检查确保没有引用或拼写错误：
  ```bash
  npm run typecheck
  ```

### 手动验证流程
1. **启动应用**：运行 `npm run dev` 启动开发服务器。
2. **主机连接**：点击左侧主机列表，验证终端是否正常连接，并能够输入 `ls`、`top` 等命令。
3. **监控收集**：检查左侧监控面板（CPU、内存、网络、磁盘等）是否每 2 秒更新一次，系统信息弹窗是否正常显示。
4. **SFTP 基础操作**：
   * 验证文件目录树是否能双击打开。
   * 新建一个文件夹，然后将其重命名，最后将其删除。
5. **文件拖放上传**：
   * 拖放一个本地测试文件/文件夹到 SFTP 文件区域，观察进度条是否显示，传输完毕后列表是否自动刷新，并且能在 Terminal 中 `ls` 查看到对应的文件。
