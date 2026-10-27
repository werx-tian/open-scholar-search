---
name: open-scholar-search
description: 开放 API 优先的学术文献检索、开放获取解析与证据分级工具。适用于“检索知网或中文文献”“找外文文献”“找免费全文”“整理核心期刊论文清单”“导出参考文献”“做带证据分级的文献综述”等请求。
metadata:
  agent_created: true
---

# 开放学术检索与证据分层

## TL;DR

- 中文：优先公开题录门户、AGRIS、中国科技论文在线、ChinaXiv；KNS 主检索不可用时如实披露，不绕过授权。
- 外文：先用 `api-search.js` 的 OpenAlex + Europe PMC，Crossref 校题录，PubMed 做精确检索。
- 全文：用 `oa-resolve.js` 依次查 OpenAlex → Unpaywall → Europe PMC → arXiv，只采信确认的 OA 链接。
- 一键执行：`pipeline.js` 完成检索、OA 解析和三格式导出，失败后可从 `oa` / `export` 续跑。
- 直接证据 L0 少于 30 条时，说明样本不足，再按对象轴逐层扩展；不要直接下“无研究”结论。

## 0. 合规与可用性判断

本技能面向开放 API 和用户有权访问的公开页面。不得绕过登录、付费墙、验证码或机构授权。无法访问时，改用合法替代渠道，并在交付物中披露实际覆盖范围。

知网 KNS 常见行为是未授权网络收到 HTTP 200，但正文只是“安全验证”壳页。判断渠道是否可用要看响应标题、正文长度、结果结构和关键词，不能只看状态码。只有确实拿到题录时，才能写“来自 KNS”。

当前实测记录：

- 2026-10-22，`selftest.js --probe` 对 OpenAlex、Crossref、Europe PMC、PubMed、DOAJ、arXiv 均收到有效响应；当次 CORE 网络层不可达。每次使用前以现场 probe 结果为准。
- 2026-09 的站点级探测见 `references/channels-cn.md` 与 `references/channels-intl.md`。站点被 Cloudflare 拦截不等于其 API 不可用。
- 实测缓存有效期 6 个月；超过有效期先复检，不把旧结论当作当前保证。

## 1. 渠道选路

| 需求 | 首选 |
|---|---|
| 中文期刊题录 | 期刊官网或其公开 `*.cbpt.cnki.net` 文章门户；用 `cnki-grab.js` 抽取 |
| 农业/水产中文与英文索引 | AGRIS（FAO） |
| 中文开放全文 | 中国科技论文在线、COAJ、ChinaXiv、期刊官网、机构库、NSTL 文献传递 |
| 综合外文检索 | OpenAlex |
| DOI/题录核对 | Crossref |
| 生命科学与 PMC 全文 | Europe PMC |
| MeSH/字段精检 | PubMed |
| 只找 OA | DOAJ |
| 机构库自存版 | CORE（建议配置 `CORE_API_KEY`） |
| 学位/会议论文 | 万方、知网等机构授权渠道；开放 API 覆盖不足 |
| 算法/模型/生物信息预印本 | 按需加入 arXiv；普通水产主题不默认加入 |

完整矩阵见 `references/channels-cn.md`、`references/channels-intl.md`，调用边界见 `references/open-apis.md`。

## 2. 构造检索式

检索式仍按三轴拆分，但不同平台要分别组装：

```text
(对象词 OR 同义对象) AND (处理词 OR 同义处理) AND (指标词 OR 同义指标)
```

| 轴 | 作用 | 示例 |
|---|---|---|
| 对象 | 物种、材料、人群、型号、作物 | 草鱼 / 鲤科 / 无胃鱼 |
| 处理 | 剂量、工艺、暴露、干预 | 投喂频率 / 限饲 |
| 指标 | 安全性、有效性、机制、结局 | SGR / FCR / 肠道菌群 |

规则：

- 同维度用 OR，不同维度用 AND；先宽后窄，最后再加年份和来源类别。
- 中文同义词要覆盖缩写、俗称、异体字和常见误写；中英文分别检索。
- 目标规模通常是 50~300 条。0 结果时按“指标 → 处理 → 对象”的顺序放宽。
- 显式传入 `AND`、括号或字段语法时，脚本会原样交给目标 API；先确认该 API 的语法，不要跨库直接复制。

### 2.1 同义词自动展开

结构化词表位于 `references/synonyms.json`：

```json
{
  "规范词": {
    "synonyms": ["中文异名"],
    "latin": "Scientific name",
    "english": "English term"
  }
}
```

执行：

```text
node scripts/api-search.js -q "嗜水气单胞菌" -s openalex,europepmc --synonyms references/synonyms.json --out hits.jsonl
```

脚本会生成中文 OR 组和英文对照检索式，各跑一次。每条记录写入 `seedQuery`、`query`、`queryLanguage`、`queryVariant` 与 `expansionTerms`，便于复现和审计。

## 3. 分层递进检索

不要把一个分类扩展式塞进单一 OR。对象外推与概念层级是两个轴：

| 对象外推轴 | 含义 |
|---|---|
| S0 | 目标物种/对象 |
| S1 | 同属或高度近缘对象 |
| S2 | 同科/同类群 |
| S3 | 跨类经济动物或人体 |
| S4 | 模式生物、细胞系、纯机制模型 |

| 概念层级轴 | 含义 |
|---|---|
| L0 | 本概念直接证据 |
| L1 | 同义词/同属近缘 |
| L2 | 科、类群、上位概念 |
| L3 | OpenAlex 高频机制/背景概念，必须显式启用 |

默认只扩展对象轴。处理词和指标词通过同一个 `--topic` 在各层保持一致。层越高，字段越收紧、条数越少：

```text
L0: 50 条，题名+摘要
L1: 30 条，题名+摘要
L2: 20 条，题名，OpenAlex 按引用数排序并应用默认最低被引阈值
L3: 10 条，题名，引用排序 + 明确外推风险
```

自动生成配置：

```text
node scripts/expand-query.js "Aeromonas hydrophila" --topic "vaccine OR immunity" --out expand.json
```

数据来源为 NCBI Taxonomy（属→科）、MeSH 上位词和 OpenAlex 前 20 条结果中的高频概念。L3 只有显式传入 `--include-l3` 才生成。也可使用人工编辑的 `examples/expand-aeromonas.json`。

执行分层检索：

```text
node scripts/api-search.js --expand expand.json -s openalex,europepmc --out hits.jsonl
```

每个检索层独立执行，不合并成一个 OR。JSONL 写入 `expansionLevel`、`expansionLevels`、`expansionLabel`、`evidenceNature`、`caution` 与 `rankedByCitations`。

报告规则：

- L0 直接证据少于 30 条时，建议扩展，并写“直接证据 N 条，其余为近缘或上位证据”。
- 每条结论标注 `Sn-Lm` 坐标；两轴层级不同，按较弱轴决定外推强度。
- L2/L3 的宿主特异性、流行病学、剂量效应和安全阈值不得直接反推到 S0。
- “未检出”只表示当前检索范围未找到；不要说成“没有研究”。

## 4. 一键流水线与脚本

所有脚本要求 Node 18+，零运行时依赖。

```text
node scripts/pipeline.js -q "feeding frequency grass carp" --source openalex,europepmc --email "you@example.com" --out-dir output --name literature
```

产物：

```text
literature-hits.jsonl
literature-with-oa.jsonl
literature.csv
literature.bib
literature.md
literature-pipeline.json
```

失败时清单会记录断点：

```text
node scripts/pipeline.js --out-dir output --name literature --from oa --email "you@example.com"
node scripts/pipeline.js --out-dir output --name literature --from export
```

各阶段也可单跑：

| 脚本 | 用途 |
|---|---|
| `api-search.js` | 七源检索、同义词展开、分层执行、警告记录 |
| `expand-query.js` | Taxonomy/MeSH/OpenAlex 生成分层配置 |
| `oa-resolve.js` | OpenAlex 批量 DOI + 有界并发逐条补查 OA |
| `cnki-export.js` | 多键去重、字段互补、按扩展层导出 |
| `pipeline.js` | 检索 → OA → 导出与断点续跑 |
| `cnki-grab.js` | 公开题录门户的浏览器抽取 |
| `cdp-fetch.js` | 已启动浏览器的通用渲染页读取与诊断 |
| `selftest.js` | 离线回归；`--probe` 检查 API 状态 |

### 4.1 外文检索

```text
node scripts/api-search.js -q "feeding frequency grass carp" -s openalex,crossref,europepmc,pubmed --year-from 2020 --scope auto --limit 30 --email "you@example.com" --out hits.jsonl
```

- `--scope auto` 会给 Europe PMC、PubMed、CORE 收敛到题名+摘要，减少全文宽松匹配噪声。
- `--source all` 才启用 DOAJ、arXiv 与 CORE；普通课题不必默认全开。
- 超时、429 或 5xx 会指数退避最多 2 次。最终失败时写出 `recordType: "warning"`，包含源、查询、层级和时间。
- OpenAlex 请求使用 `select=` 只取题录所需字段；返回已确认的 OA 位置。

### 4.2 OA 解析

```text
node scripts/oa-resolve.js -i hits.jsonl -o with-oa.jsonl --email "you@example.com" --concurrency 5 --report
```

- `--email` 必须由用户提供真实地址。Unpaywall 强制要求；缺失时该源自动跳过。
- 只有 `open_access.is_oa === true` 或对应 OA location 才标记可获取，不能把付费落地页当全文。
- 默认 5 路记录并发，但每个 API 独立串行限速；单源失败只降级该源，并写 `_warnings`。

### 4.3 去重与导出

```text
node scripts/cnki-export.js -i with-oa.jsonl -o references.bib --format bibtex --sort expansion
```

- 支持 CSV、TSV、BibTeX、Markdown、JSON。
- 同一记录同时注册 DOI 与题名键，可合并“有 DOI”和“同题名缺 DOI”的记录，并补充较短版本缺失的摘要、基金、作者等字段。
- 题名键使用 NFKC、大小写归一和 Unicode 标点归一，能合并全角/半角冒号及大小写差异。
- Markdown 在 `--sort expansion` 时按 L0/L1/L2 分节，并附证据性质和风险提示。

## 5. 中文题录与渲染页

只抓公开可访问、且用户有权查看的文章页。`cnki-grab.js` 文件头包含同样的使用边界声明。

```text
node scripts/cnki-grab.js --launch --warm "https://www.cnki.net/" --urls urls.txt --out records.jsonl --wait 6000
```

浏览器选择：

- 优先使用系统 Edge/Chrome/Chromium。
- 可用 `BROWSER_PATH` 指定可执行文件，避免路径探测失败。
- 某些沙箱会在一次工具调用结束后回收后台进程；CDP 不可达时，把浏览器启动和抓取放在同一进程，或用产品提供的后台会话单独常驻。

## 6. 交付报告

使用 `references/report-template.md` 的规则，并从 `assets/report-template.html` 套用版式。报告顺序：

1. 数据可得性、实际检索式与去重前后条数
2. 核心文献清单（题录、OA 状态、对象/规格、方法、结论、S/L 坐标）
3. 专题归纳与冲突解释
4. 横向汇总（对象 × 条件 × 梯度 × 结论 × 判据 × 坐标 × 来源）
5. 规律、适用边界与外推风险
6. 可执行启示

结论必须能回溯到具体文献序号；没有全文时说明依据仅来自题录或摘要。

## 7. 环境、验证与索引

```text
node scripts/selftest.js
node scripts/selftest.js --probe
node scripts/selftest.js --probe --json
```

离线自测覆盖去重、字段合并、层级保留和五种格式。遇到 Windows/CDP 问题时读 `references/env-troubleshooting.md`。

| 文件 | 用途 |
|---|---|
| `references/synonyms.json` | 结构化中英同义词表 |
| `references/search-strategy.md` | 平台语法、词表模板与调优 |
| `references/open-apis.md` | API 限流、字段和响应陷阱 |
| `references/open-access.md` | OA 渠道、状态与人工兜底 |
| `references/report-template.md` | 二维证据矩阵与报告结构 |
| `assets/report-template.html` | 可直接套用的 HTML 报告模板 |
| `examples/expand-aeromonas.json` | 三层人工配置示例 |
| `examples/sample-records.jsonl` | 离线导出样例 |
| `references/known-findings.example.md` | 结论缓存格式示例；真实缓存不随公开版本分发 |
