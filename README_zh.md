<div align="center">

# arxiv_marker_ccf2026

**在 Zotero 9 中把 arXiv 预印本解析为经过核验的正式发表记录，并离线显示 CCF 2026 等级。**

[![版本](https://img.shields.io/badge/version-1.0.0-2563eb?style=flat-square)](manifest.json)
[![Zotero](https://img.shields.io/badge/Zotero-9-cc2936?style=flat-square)](https://www.zotero.org/)
[![CCF](https://img.shields.io/badge/CCF-2026-f59e0b?style=flat-square)](data/CCF_2026_SOURCE.md)
[![目录](https://img.shields.io/badge/catalogue-681%20venues-7c3aed?style=flat-square)](data/ccf_2026_quick.md)
[![许可证](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](LICENSE)
[![构建](https://img.shields.io/badge/XPI-reproducible-0f766e?style=flat-square)](tools/build-xpi.py)

[English](README.md)

</div>

`arxiv_marker_ccf2026` 是基于原版 `arxiv-marker` 思路重构的独立 Zotero 9 插件。它会查找
arXiv 预印本的正式会议或期刊版本，核验证据，在写入前展示所有拟修改内容，并在 Zotero
文献列表中提供本地 Venue 与 CCF 2026 列。

本插件使用独立的插件 ID、偏好项、缓存、运行报告和撤销快照，不与原版插件共享状态。
本项目不是 Zotero、arXiv 或中国计算机学会的官方产品。

## 功能概览

| 能力 | 说明 |
|---|---|
| 正式发表版本发现 | 根据 arXiv ID、DOI、题名、作者、年份、Zotero 现有字段、学术 API 和官网识别正式记录。 |
| 写入前审核 | 展示来源、置信度、CCF/CORE 等级、类型变化和拟写入字段，由用户决定是否写入。 |
| 离线 CCF 2026 | 内置第七版目录全部 681 条记录：295 个期刊、386 个会议。 |
| Zotero 原生列 | 无需 easyScholar 或 zotero-style，即可显示“会议/期刊”和彩色“CCF 2026”列。 |
| 安全写回 | 写入前保存完整快照，并提供最近一次写入的撤销命令。 |
| 有界网络调度 | 支持分阶段并发、来源限速、截止时间、取消、请求去重、短期熔断和持久缓存。 |

## 工作流程

1. 在 Zotero 中选择论文父条目或一个分类。
2. 插件读取本地元数据，并发查询符合条件的发现来源。
3. 使用原始题名、作者、年份、DOI 和 venue 身份核验候选记录。
4. 审核窗口展示证据和拟写入的 Zotero 字段。
5. 只写入用户勾选的条目；写入前状态可用于撤销。

弱证据、超时、限流和网络错误会分别报告。未能核验不等于论文一定没有正式发表。

## 检索来源

解析器可以组合使用：

- arXiv Atom 元数据和 arXiv 摘要网页；
- Semantic Scholar、DBLP、OpenReview、Crossref 和 DataCite；
- OpenCitations Meta 和可选的 OpenAlex；
- DOI 内容协商以及 Crossref 关联版本 DOI；
- 会议与出版方官网，包括 AAAI OJS 和定向 USENIX 页面；
- 可选 Brave Search，以及无需密钥的 DuckDuckGo HTML/Lite 兜底。

搜索摘要和普通网页只作为候选证据。插件仍会核验题名、作者和 venue，符合条件后才提出写入。

## 相比原版 arxiv-marker 的变化

- 仓库收敛为单一的 Zotero 9 原生插件，删除旧 Python CLI、本地 Web UI、重复发布报告和双重版本体系。
- 用分阶段、有界的单条目并发解析替代全局批次屏障和大量串行兜底。
- 修复浏览器 JSON XHR 读取问题，避免成功响应因访问无效的 `responseText` 而被丢弃。
- 新增或增强 arXiv 网页兜底、AAAI OJS、DOI CSL 内容协商、Crossref 关联 DOI、官网元数据和经过核验的 Web 搜索。
- 增加请求预算、主机族限速、并发请求合并、短期熔断、持久缓存和真实请求取消。
- 内置完整 CCF 2026 目录并采用保守匹配；Workshop、Findings、Tutorial、Demo 和伴随赛道不会继承主会等级。
- 使用独立插件身份和存储命名空间：`arxiv_marker_ccf2026@local`。
- 固定 XPI 文件顺序、时间戳、路径和权限，使打包结果可重复。

## 安装

### 从源码构建

打包只需要 Python 标准库：

```powershell
py -3 .\tools\build-xpi.py
```

输出文件：

```text
build/arxiv_marker_ccf2026-1.0.0.xpi
```

### 安装到 Zotero

1. 在 Zotero 9 中打开“工具 → 插件”。
2. 选择“从文件安装插件”。
3. 选择生成的 XPI。
4. 完整退出并重新启动 Zotero。

插件从最新 GitHub Release 读取更新清单。由于本仓库为私有仓库，GitHub 会要求对更新清单和
XPI 资产进行身份认证；具体边界见下方“私有仓库更新限制”。

## 使用方法

- 右键选中的论文父条目，选择“用 arxiv_marker_ccf2026 解析会议/期刊”。
- 右键分类可以批量处理其中的普通文献条目。
- 在审核窗口检查结果，勾选可信条目并点击“写入所选”。
- 对漏检或困难条目使用“深度重新检索所选条目”；该功能跳过查询缓存，并在更大预算内扩展来源。
- 从“工具”菜单停止当前任务、清空查询缓存或撤销最近一次写入。
- 在 Zotero 文献列表的列选择器中启用“会议/期刊”和“CCF 2026”。

### 手工覆盖

人工核验 venue 后，可以在 Zotero 条目的 `Extra` 字段中添加：

```text
arxiv_marker_ccf2026-venue: AAAI
arxiv_marker_ccf2026-year: 2025
```

## 配置建议

| 设置 | 建议值 | 说明 |
|---|---:|---|
| 并发条目数 | `3` | 可设置为 1–6。 |
| 会议官网检索 | 开启 | 查询受支持的会议和出版方页面。 |
| Web 搜索兜底 | 开启 | 只在更强的结构化路径之后使用。 |
| DuckDuckGo 兜底 | 开启 | 无需 API key，但仍可能被限流。 |
| 深度模式 | 关闭 | 建议只用于少量困难条目。 |
| 自动勾选置信度 | `0.80` | 更低置信结果仍会展示，但默认不勾选。 |

Semantic Scholar、OpenCitations、OpenAlex 和 Brave 凭据均为可选。缺少必要凭据的来源会被跳过，
其他检索路径仍可继续运行。

普通模式每篇活动条目约有 45 秒预算，深度模式约有 90 秒。单个 HTTP 请求最多 8 秒，或受
来源/条目剩余预算进一步限制。

## 数据维护

生成后的运行时目录位于 `content/scripts/zm-data.js`。修改 `data/` 后运行：

```powershell
node .\tools\gen-data.mjs
```

生成器会先检查 CCF 条目数量，再替换运行时数据。

## 项目结构

```text
bootstrap.js                       Zotero 生命周期与运行时加载
manifest.json                      插件身份与兼容范围
prefs.js                           默认偏好项
content/                           界面、解析器、网络调度和生成后的运行时数据
data/                              CCF 2026 与 venue 匹配源数据
tools/build-xpi.py                 可重复 XPI 构建脚本
tools/build-xpi.ps1                PowerShell XPI 构建脚本
tools/gen-data.mjs                 运行时数据生成器
```

## 隐私与边界

- 查询缓存和最近一次运行报告保存在 Zotero 数据目录中，可能包含论文题名、条目标识、证据 URL 和公开检索结果。
- 插件不会主动把 API key 写入缓存或运行报告；Zotero 的完整调试输出仍可能包含请求 URL，分享前应检查并脱敏。
- 公共 API 和出版方网站可能改版、限流、阻止自动访问或缺少正式发表信息；证据不足时插件会主动弃权。
- 源码级检查和可重复打包不能替代真实 Zotero 用户配置中的安装验证。

### 私有仓库更新限制

`manifest.json` 和 `update.json` 使用 Zotero 标准更新格式和稳定的 GitHub Release URL。
GitHub 不允许匿名访问私有仓库的 Release 资产，而 Zotero 更新器不会携带 GitHub 凭据。因此，
这些链接可用于已登录 GitHub 的访问和手工安装；若要实现无人值守的 Zotero 自动更新，必须把
同一份 `update.json` 和 XPI 托管到公开 HTTPS 地址。不要在更新地址中嵌入个人访问令牌。

## 许可证与来源

项目代码使用 [MIT License](LICENSE)。CCF 目录作为本地书目匹配数据使用，仍受其发布方权利约束。
来源和匹配策略见 [data/CCF_2026_SOURCE.md](data/CCF_2026_SOURCE.md)。
