---
description: "确定性抽取式文本压缩：调用方需要把长文本装进有限预算时使用。"
kind: "package-library"
---

# dsh-util-text-extract

[English](README.md) | 中文

## 概述

一个纯函数 `compressToBudget`：把长文本中信息量最高的片段保留在字符预算内，而不是切掉一个原始前缀。标题永远保留；句子按关键词密度、位置与长度适配度打分；冗余闸门丢弃与已选内容大量重复的候选（页脚、重复公告）。CJK 二元组与拉丁词共用同一条打分路径，中英文页面在同一套规则下压缩。输出在所有平台上都是输入的确定性函数，因此面向模型的渲染可重放。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与未做的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务或插件**：不碰 `ctx`，不注册任何东西，零依赖。

```ts
import { compressToBudget } from '@deepseek-ai/dsh-util-text-extract'

declare const pageText: string // the rendered text of the page

const kept = compressToBudget(pageText, 4000)
```

<a id="api"></a>
## API

- `compressToBudget(text, budget)` — 压缩后的文本，长度永不超过 `budget`；原文不超预算时原样返回。
- `scoreBlocks(text)` — 打分后的块列表（index、text、separator、score），供想检查或复用排序的调用方使用。
- `COMPRESSION_FOOTER` — 调用方在压缩结果后追加的固定英文提示；预算要为它的长度留位。
- `DEFAULT_EXTRACT_BUDGET_CHARS` — 预算常量，调用方可复用以保持一致。

<a id="model-experience"></a>
## 模型体验

间接地，通过选择打开压缩的工具渲染（`web_fetch` 的 `fetchExtractiveCompression` 与 `page_extract_text` 的 `extractTextCompression`）——压缩输出带固定提示，告知模型拿到的是选摘。

#### KV Cache 影响

本包自身无效应。压缩文本随消费方工具的结果回合走，渲染是工具结果的确定性函数，重放会重建出完全相同的文本。

## 已知限制与未做的工作

<a id="known-limitations-and-deferred-work"></a>

- **基于词频打分，不涉及语言模型** — 信号集中在低频专有名词的页面压缩效果不如信号在主题词汇上的页面；尾部保底为结尾一次性陈述保留一个采样位，但选摘仍是统计性的。
- **句终符固定** — 分句覆盖 `.` `!` `?` `。` `！` `？` `；` `;`；其他句终符会留在块内。

### 开发备注

<a id="dev-note"></a>

`scoreBlocks` 已导出，供测试与调用方检查排序；冗余闸门跳过与已选内容词项重合超过 0.6 的候选，短片段（词项少于六个）豁免——它们没有足以判断的证据。
