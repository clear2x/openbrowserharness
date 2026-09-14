---
description: "ctx.fs provider 契约的 OPFS（ Origin Private File System）实现，面向浏览器宿主。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-opfs

[English](README.md) | 中文


```ts ignore-check
import { OpfsFileSystem } from '@deepseek-ai/dsh-fs-opfs'

await ctx.plugin(OpfsFileSystem, { cwd: '/' })
// ctx.fs uses the OPFS backend; load @deepseek-ai/dsh-fs-observation-policy for the
// freshness policy gate and @deepseek-ai/dsh-tool-fs to expose read/write/edit.
```

## 概述

浏览器宿主（扩展 offscreen 文档、web shell）下 `ctx.fs` 提供者契约（[`@deepseek-ai/dsh-fs`](../fs)）的 **OPFS（Origin Private File System）实现**。以页面 origin 内的 OPFS 句柄树支撑 `FileSystem` 的十二个原语；作为插件装载后即填充 `ctx.fs`。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与未竟工作](#known-limitations-and-deferred-work)

<a id="behavior"></a>

## 行为

- **`resolve(path, opts?)`** — 相对 `path` 先用调用方给出的 `opts.cwd`，否则用 `config.cwd`（默认 `/`）；绝对 `path` 忽略两者。这个显式解析步骤会折叠点段并把超出根的 `..` 钳制在 OPFS 根（与 local 后端在其文件系统根处的祖先回溯行为一致）。规范形 `/a/b` 同时充当 `displayPath` 与稳定的 `targetKey`：OPFS 没有符号链接，规范化相等的别名天然共享同一身份。OPFS 的 origin 隔离即约束 —— `config.cwd` 是解析默认值，不是沙箱。
- **执行世界坐标** — `processPath` 暴露规范的 OPFS 路径拼写；其背后没有 OS 路径或子进程世界。`fileUrl` 用 `opfs` scheme 命名该路径，让展示类消费者获得稳定拼写；它不是 `file:` URI，也不可 fetch（OPFS 不提供 `file:` scheme）。`contains` 用规范路径前缀测试同一或后代包含关系。
- **`stat` / `lstat`** — 返回目标元数据，缺席返回 `undefined`。`version` 由提供者侧的按路径变更修订号与快照的 `size`/`lastModified` 组成；write/edit 结果令牌额外附加发布字节的 FNV-1a 内容摘要，而读取侧令牌只含元数据（读取从不读内容）。即便变更来自共享 origin 上的其他上下文（SidePanel 与 offscreen 共享同一 OPFS）、提供者从未见过它们，令牌仍会改变。OPFS 条目只有文件与目录，`lstat` 因此永远不会报告 `symlink`。
- **`readText` / `streamText`** — 仅 UTF-8。`readText` 读取整个文件快照；`streamText` 对快照字节流逐块解码，大文件不必整体驻留内存。两者都拒绝 NUL 字节二进制样本（`FS_NOT_TEXT` —— 编辑路径查整个缓冲，读取路径查前 8 KiB，与 `dsh-fs-local` 一致）与非常规目标。
- **`readBytes`** — 原始整文件字节，不解码、不拒绝二进制。字节上限先按快照大小短路，再在读取后复核长度：快照之后长过上限的文件报 `FS_TOO_LARGE`，绝不截断返回。
- **`listDir`** — 按稳定的 `name.localeCompare()` 序列出一层目录，附子项类型、已解析子目标、version 与文件 `size`；从不读取文件内容。缺失目标报 `FS_NOT_FOUND`，文件目标报 `FS_NOT_DIRECTORY`，列目录开始后消失的子项以无元数据的 `other` 报告。
- **`writeText`** — 原子：内容经平台的 swap 型写入器（`createWritable`）发布 —— 每个块都先写入盘外交换文件，仅在 `close()` 时换入。`close()` 之前的终止或失败经 `abort()` 丢弃交换文件，可见文件保持不变并释放写入器的锁；缺失的父目录会被补建。`expected` 守卫可选：省略即无条件 create-or-overwrite；`createIfAbsent` 只是提供者按目标变更锁下的互斥（见限制）；`replaceIfVersion` 只在观测版本上替换 —— 缺席、元数据不匹配、或内容摘要不匹配（当期望令牌与写前快照都携带摘要时）都报 `FS_STALE_VERSION`，这正是元数据看不见的同尺寸同毫秒重写被拦下的机制。覆盖写入仅当先前文件与 UTF-8 替换文本都严格低于 `config.diffBasisMaxBytes`（默认 10 MiB）时才返回旧文本作为上下文 diff 基准；否则 `before: null`，展示层回退到整文件 diff。
- **`editText`** — 同一原语上的原子字面读-改-写，由变更锁按目标串行化。`expected` 守卫可选：给出时在字面匹配之前校验版本 —— 元数据，以及在期望令牌与已物化快照都携带时的内容摘要（过期编辑报 `FS_STALE_VERSION`，绝不会对着更新的内容报 `FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT`）；省略即无条件编辑当前内容。缺失目标两条路径都报 `FS_STALE_VERSION`。匹配前做 LF 归一，写回时恢复文件主导的 CRLF/LF 风格；空 `oldString` / 零匹配报 `FS_EDIT_NOT_FOUND`，未开 `replace_all` 的多义匹配报 `FS_AMBIGUOUS_EDIT`。

包根 SDK API 是 default/具名导出的 `OpfsFileSystem` 类与 `Config`。平台机械细节位于 `src/opfsio.ts`，背后是 `src/opfs.ts` 的窄句柄 seam（内存 fake 可以完整模拟该 seam —— 见测试）；`src/index.ts` 是薄服务接线。

<a id="model-experience"></a>

## 模型体验

间接地，经 [`dsh-tool-fs`](../tool-fs/README.zh.md) 呈现：该工具包在保留上限内渲染本提供者的按行窗口 UTF-8 内容、变更确认与精确错误消息；版本、swap 写入机制与目录元数据保持内部细节。

#### KV Cache 效应

无直接失效；由具名消费者管理任何请求前缀变化。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与未竟工作

- **`config.cwd` 不是沙箱** —— 它是解析默认值，不是约束。约束事实是 OPFS 的 origin 隔离本身：模型只能寻址 origin 私有文件系统内的文件，永远接触不到用户磁盘。
- **`createIfAbsent` 是锁范围而非 OS 原子** —— 该守卫只串行化本提供者实例内的变更，而 OPFS 没有可供其借力的独占创建原语：`getFileHandle(name, { create: true })` 是静默的 get-or-create，不提供「新建还是已存在」信号；`createWritable` 打开已存在文件不会以独占失败报错；swap 写入器的锁也不跨同 origin 上下文，因此跨上下文锁协议同样关不上这个窗口。同一 origin 上另一上下文的创建者仍可能先创建文件，版本守卫随后会在下次读取时报告该变化。
- **守卫强度取决于提供者实际读取了什么** —— write/edit 结果令牌携带内容摘要，因此「观测→write/edit→守卫」流程能拦下同尺寸同毫秒的外部重写；来源于读取侧令牌（`stat`/`listDir`，从不读内容）的守卫、以及写前快照未被读取（达到/超过 `diffBasisMaxBytes`）的守卫，只校验元数据。字节完全一致的重写一律放行 —— 与未发生变化不可区分。FNV-1a 是 32 位快速摘要而非密码学哈希：刻意构造出同摘要的重写仍可能蒙混过关。提供者自身的变更总是推进修订号。
- **`editText`/`writeText` 将整个文件驻留内存** —— 只有读取路径支持流式。
- **没有删除或移动** —— `FileSystem` 契约两者皆无，而 OPFS 的重命名原语（仅 worker 可用的同步句柄 `move`）在文档中不可用。若契约将来增加删除，本提供者随之增加 `removeEntry`。

## 开发备注

本包为 fork 新增，随扩展发布节奏演进；接口变化时同步更新上表与目录。
