# 单元测试全覆盖 任务清单

- [x] 编写主机存储单元测试 `store.test.ts`
  - [x] 实现 Electron `app` 和 `safeStorage` 的 Mock 拦截
  - [x] 覆盖主机的新增（UUID 生成）、编辑（密码占位符更新）、列表查询（隐私保护）、删除以及获取详情等所有方法
  - [x] 确保测试结束后自动清理测试产生的本地缓存文件
- [x] 编写 SFTP 传输队列与异步遍历测试 `sftpService.test.ts`
  - [x] Mock SSH2 `Client` 和 `SFTPWrapper` 连接信道
  - [x] 实现 fastPut/fastGet 的进度 `step` 及回调模拟
  - [x] 编写单文件排队与并发并发控制 (MAX = 3) 机制的验证测试
  - [x] 编写单文件取消 (Cancel) 操作在不同状态（queued/running）下的中断测试
  - [x] 使用本地临时目录测试 `walkDirectoryAndQueue` 异步文件收集
- [x] 运行与结果核对
  - [x] 运行 `npm run typecheck` 验证测试文件的 TS 语法
  - [x] 运行 `npm run test` 验证所有 3 个测试套件均 100% 成功通过
