# Open Scholar Search

[English](README.md) | **简体中文**

开放 API 优先的学术文献检索、开放获取解析、证据分层与题录导出技能。无需机构授权即可完成外文检索；单一来源不可用时按源降级，不中断整批任务。

## 最适用的场景

**围绕一个关键词、物种、方法或研究方向，迅速查询并整理权威、高水准的参考文献。** 技能结合多源发现、DOI 题录核对、引用排序、开放获取全文定位和证据层级标注，可用于课题摸底、开题准备、论文参考文献整理，以及快速找到一个陌生领域最值得优先阅读的代表性论文。

这里的“权威、高水准”指工具会优先组织高质量来源、引用信息和证据层级，不会把检索结果自动视为权威结论。正式引用前仍应核对来源覆盖、研究设计、引用情况和适用边界。

## 主要能力

- 检索 OpenAlex、Crossref、Europe PMC、PubMed、DOAJ、arXiv、CORE
- 按结构化同义词表分别生成中英文检索式
- 使用 Taxonomy、MeSH、OpenAlex 生成对象分层并写入 `expansionLevel`
- 通过 OpenAlex、Unpaywall、Europe PMC、arXiv 解析 OA 全文
- DOI + 归一化题名多键去重，同时合并互补字段
- 导出 CSV、TSV、BibTeX、Markdown、JSON；Markdown 可按证据层分节
- 一键执行检索 → OA 解析 → 导出，并支持断点续跑
- 提供离线回归和七源在线探测

## 环境

Node.js 18+，无运行时依赖。把本目录放到：

```text
$CODEX_HOME/skills/open-scholar-search
```

使用时显式调用 `$open-scholar-search`。

## 快速开始

```text
node scripts/pipeline.js -q "投喂频率 草鱼" --source openalex,europepmc --email "you@example.com" --out-dir output --name literature
```

若 OA 阶段失败，无需重新检索：

```text
node scripts/pipeline.js --out-dir output --name literature --from oa --email "you@example.com"
```

自动分层：

```text
node scripts/expand-query.js "Aeromonas hydrophila" --topic "vaccine OR immunity" --out expand.json
node scripts/api-search.js --expand expand.json --source openalex,europepmc --out hits.jsonl
```

## 访问边界

- 使用自己的真实邮箱进入 OpenAlex/Crossref polite pool；Unpaywall 强制要求真实邮箱。
- CORE 建议注册 key，并设置 `CORE_API_KEY`。
- 浏览器抓取只处理公开且用户有权访问的页面，不绕过登录、付费墙、验证码或机构授权。
- KNS 未授权时，报告必须注明“未直接从 KNS 获得记录”，不得暗示已检索。

## 验证

```text
node scripts/release-check.js
node scripts/selftest.js
node scripts/selftest.js --probe
```

`release-check.js` 会阻止个人路径、真实邮箱、私钥和访问 token 进入公开仓库。

## 许可证

代码采用 MIT；文档与报告模板采用 CC BY 4.0，详见 `DOCS-LICENSE.md`。
