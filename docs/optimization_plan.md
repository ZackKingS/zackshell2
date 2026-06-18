# zack-shell 架构优化实施计划

为了解决前面评估中发现的 **模块职责过度耦合**、**大文件/大文件夹传输同步阻塞与串行低效**、**监控系统兼容性单一** 以及 **大目录渲染卡顿** 等问题，特制定本优化计划。本计划分为四个阶段逐步推进，确保每一步都可独立测试和验证。

---

## 优化目标

1. **高内聚低耦合**：重构主进程 `SSHManager`，实现 SRP（单一职责原则）。
2. **高效且高弹性的 SFTP**：引入非阻塞异步 I/O 及支持并发控制的任务队列，支持暂停/取消及文件夹高速传输。
3. **更广泛的监控兼容性**：支持 Linux 外的其他主流类 Unix 操作系统（如 macOS/BSD）。
4. **极致的前端性能**：在 React 中实现十万量级文件秒开的虚拟列表，及使用轻量级状态库降低全局重绘。

---

## 阶段一：主进程解耦与职责划分（SRP 重构）

本阶段主要对 `SSHManager.ts` 进行拆分，保持对外 IPC 接口不变，但内部逻辑模块化。

### 1. 拟拆分模块结构
* **新建 `src/main/services/connectionPool.ts`**
  * 职责：维护每个 `sessionId` 的 `ssh2.Client` 实例，处理连接就绪（ready）、错误（error）、断开（close）等生命周期。
* **新建 `src/main/services/sftpService.ts`**
  * 职责：封装 SFTP 的原生异步方法（列清单、修改权限、文件夹创建等），并承接上传下载的启动入口。
* **新建 `src/main/services/telemetryService.ts`**
  * 职责：周期性拉取监控指标，计算 CPU/Net 的 Delta 差值并返回快照。
* **修改 `src/main/sshManager.ts`**
  * 职责：作为门面（Facade Pattern），接受 IPC 入口分发至相应 Service，不再保存复杂的内部解析和读写逻辑。

### 2. 验证点
* 已连接的 Terminal 和 Monitor 在重构后运行正常，无数据断流。

---

## 阶段二：SFTP 非阻塞 I/O 与并发任务队列

解决同步 `readdirSync`/`statSync` 阻塞主进程以及串行上传缓慢的问题。

### 1. 引入异步目录遍历
* 在 `sftpUpload` 中，使用 `fs.promises.readdir` 和 `fs.promises.stat` 替代同步方法。

### 2. 建立 `TransferQueue`（任务队列管理器）
* **控制维度**：
  * 支持最大并发限制（如最多 3 个并发线程，其余排队中）。
  * 引入 `cancel(transferId)` 接口，强行中止 `ssh2` 底层的 fastGet/fastPut 读写流。

### 3. 验证点
* 拖入包含 100 个小文件的文件夹，能够并发启动传输（速度相比之前有成倍提升）。
* 点击“取消”按钮后，传输进度立即停止，且远端文件残留被清理。

---

## 阶段三：多操作系统监控兼容性嗅探

解决目前只支持 Linux 的缺陷。

### 1. 动态监控命令映射
* 主机连接成功后，执行 `uname -s` 确定 OS 平台类型：`Linux` / `Darwin (macOS)` / `FreeBSD` / `Others`。
* 根据平台动态切换执行的监控语句：

| 平台 | CPU 采集手段 | 内存采集手段 | 进程 TOP 采集 |
| :--- | :--- | :--- | :--- |
| **Linux** (当前) | `grep '^cpu ' /proc/stat` | `cat /proc/meminfo` | `ps -eo pid,pcpu,rss,comm` |
| **Darwin (macOS)**| `sysctl -n vm.page_free ...` | `vm_stat` | `ps -Ao pid,pcpu,rss,comm -r` |
| **BSD** | `sysctl kern.cp_time` | `sysctl hw.physmem ...` | `ps -aux -m` |

### 2. 验证点
* 连接至 macOS 开发机或本地主机时，监控面板图表能够正常展示，不会报错或无响应。

---

## 阶段四：前端虚拟化与状态管理优化

解决 React 大组件重绘与超大目录卡死的问题。

### 1. 全局状态库 Zustand 引入
* 在 `src/renderer/src/` 引入 `zustand` 替代 `App.tsx` 中零散的 `useState`。
* 共享 `sessions` 状态，组件（侧边栏、监控、SFTP）根据订阅的 `activeSessionId` 进行按需消费，减少不必要的 Parent Re-render。

### 2. SFTP 表格虚拟化（Virtual Table）
* 引入 `react-window` 对 `SftpPanel.tsx` 的文件列表进行表格虚拟化。
* 仅仅将屏幕可见范围内的行（通常为 30-50 行）转换为 DOM 元素。

### 3. 验证点
* 在远程主机 `/usr/bin` (可能含有几千个可执行文件) 的目录下，文件双击打开瞬间完成渲染，滚动无滞后与顿卡。
