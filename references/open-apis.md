# 开放 API 清单与调用要点

本文件是 `scripts/api-search.js` 与 `scripts/oa-resolve.js` 的依据。基础探测记录为 2026-09；2026-10-22 的轻量 probe 中，OpenAlex、Crossref、Europe PMC、PubMed、DOAJ、arXiv 均返回有效结构，CORE 当次网络层不可达。限流与站点状态会变化，缓存有效期按 6 个月处理，使用前可运行 `scripts/selftest.js --probe` 复检。

## 一、总览

| 源 | 端点 | 需要 key | 实测限流行为 | 覆盖与定位 |
|---|---|---|---|---|
| **OpenAlex** | `api.openalex.org/works` | 否 | 未触发；建议带 `mailto` 进 polite pool | 全学科，2 亿+ 作品。含引用数、概念标签、**OA 链接**、摘要（倒排索引） |
| **Crossref** | `api.crossref.org/works` | 否 | 未触发；建议带 `mailto` | DOI 官方注册元数据，题录最权威。摘要覆盖不全 |
| **Europe PMC** | `www.ebi.ac.uk/europepmc/webservices/rest/search` | 否 | 未触发 | 生命科学，含 PMCID 与**免费全文直链**，摘要覆盖好 |
| **PubMed E-utilities** | `eutils.ncbi.nlm.nih.gov/entrez/eutils/` | 否 | 未触发；官方建议无 key 时限 3 请求/秒 | MEDLINE。MeSH 与字段限定语法强 |
| **DOAJ** | `doaj.org/api/search/articles/` | 否 | 未触发 | 开放获取期刊目录，**100% 免费全文**，摘要完整 |
| **CORE** | `api.core.ac.uk/v3/search/works` | **官方要求**（实测无 key 也可用） | **极严，连续请求即 429** | 全球机构知识库聚合，开放全文 |
| **arXiv** | `export.arxiv.org/api/query` | 否 | 官方要求间隔 **3 秒** | 预印本，对水产养殖领域很弱 |
| **Unpaywall** | `api.unpaywall.org/v2/<doi>` | **强制 `email` 参数** | 未触发 | OA 状态权威判定，返回 PDF 直链 |
| **DataCite** | `api.datacite.org/dois` | 否 | 未触发 | 数据集与软件 DOI |
| **Zenodo** | `zenodo.org/api/records` | 否 | 未触发 | 通用仓储 |
| **bioRxiv** | `api.biorxiv.org/details/biorxiv/<doi>` | 否 | 未触发 | 生命科学预印本 |
| **OpenAIRE** | `api.openaire.eu/search/publications` | 否 | 未触发 | 返回 **XML**，非 JSON |
| **AGRIS（FAO）** | `agris.fao.org/search/en?q=` | 否 | 未触发 | **非 API**，是服务端渲染 HTML，可直接抓取解析 |

## 二、逐源调用要点

### OpenAlex

```
GET https://api.openalex.org/works?search=<词>&per-page=25&page=1&mailto=<邮箱>
GET https://api.openalex.org/works?filter=doi:10.1/a|10.1/b|...&per-page=50    # 批量 DOI
```

- **`mailto` 参数**：进入 polite pool，显著降低被限流概率。强烈建议填
- **摘要以倒排索引存储**，字段名 `abstract_inverted_index`，形如 `{"word": [0, 5, 12]}`，索引是词在摘要中的位置，需按位置重排还原成句子（两个脚本均已实现 `restoreInverted`）
- **字段范围检索**：`search=` 是全字段，`filter=title_and_abstract.search:<词>` 收敛到题名+摘要，`filter=title.search:<词>` 仅题名
- **OA 判定**：`open_access.is_oa` 与 `oa_status` 是权威结论，`best_oa_location.pdf_url` 通常就是可直接下载的链接
- **批量 DOI 查询**用 `|` 分隔（管道符），单次上限 50 个，这是 `oa-resolve.js` 高效的原因
- **`locations` 数组里混有非 OA 的出版商落地页**。必须用 `is_oa === true` 过滤，否则会把付费文献误判成有免费全文。这是实测踩到的坑
- **`select` 字段白名单与顶层字段名不一致**：`is_oa` **不是**合法 select 字段，传了直接 400。合法字段以报错信息里列出的为准，OA 状态要写 `open_access`。本版本实测可用并已采用的组合：
  `select=id,doi,display_name,authorships,primary_location,biblio,open_access,best_oa_location,publication_year,keywords,abstract_inverted_index,type,language,cited_by_count,concepts`
- 官网 `openalex.org` 被 Cloudflare 拦（403 `Just a moment...`），**只能用 API**

### Crossref

```
GET https://api.crossref.org/works?query.bibliographic=<词>&rows=25&mailto=<邮箱>
```

- **不要传 `select` 参数**：其白名单会随字段调整变化，实测传了 `language` 会导致整个请求 400 `select-not-available`。拿全量 payload 更稳
- 时间过滤：`filter=from-pub-date:2020-01-01,until-pub-date:2026-12-31`
- 摘要字段 `abstract` 是 **JATS XML 片段**（含 `<jats:p>` 等标签），需剥标签；且覆盖不全
- **会混入非论文条目**：图片、表格在 Crossref 有独立 DOI（type 为 `component`），题名形如 `Figure 1: xxx`。`api-search.js` 已按题名正则 + type 黑名单过滤
- **`link` 字段是出版商全文地址，不代表免费**。绝不能据此判定开放获取——需查 OpenAlex / Unpaywall

### Europe PMC

```
GET https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<词>&format=json&resultType=core&pageSize=25
```

- `resultType=core` 才会返回 `fullTextUrlList`、`keywordList`、`journalInfo` 等完整字段
- 字段前缀：`TITLE:` `TITLE_ABS:` `AUTH:` `JOURNAL:` `DOI:`；`OPEN_ACCESS:Y` 限定 OA；年份用 `PUB_YEAR:[2020 TO 2026]`
- **默认全字段检索精度极差**。实测 `feeding frequency grass carp` 返回 578 条，前几条是《Circulation》心血管病综述、肝吸虫论文、PFAS 风险评估——与主题完全无关。收敛到 `TITLE_ABS:` 后降至 4 条且全部相关
- `fullTextUrlList.fullTextUrl` 需按 `availability !== 'Subscription'` 过滤，否则会拿到订阅链接
- 有 `pmcid` 即意味着 PMC 里有免费全文，可直接构造 `https://www.ncbi.nlm.nih.gov/pmc/articles/<PMCID>/`

### PubMed E-utilities

```
GET .../esearch.fcgi?db=pubmed&term=<词>&retmode=json&retmax=25&sort=relevance
GET .../esummary.fcgi?db=pubmed&id=<逗号分隔>&retmode=json
GET .../efetch.fcgi?db=pubmed&id=<逗号分隔>&retmode=xml
```

- **必须两步以上**：`esearch` 只能拿到 PMID 列表，`esummary` 才有题录
- **`esummary` 不返回摘要**，只有 `efetch`（XML）有。`api-search.js` 会自动补一次 efetch 取摘要与关键词
- 年份写法：`AND (2020:2026[dp])`
- 作者在 `esummary` 里是 `Keve G` 这种缩写形式，`efetch` 能给出完整 `ForeName + LastName`
- 2020 年后 NCBI 的 `pmc/utils/oa/oa.fcgi` 旧接口返回 404，**改用 esummary 里的 PMCID 直接拼 PMC 链接**

### DOAJ

```
GET https://doaj.org/api/search/articles/<URL编码的检索式>?pageSize=25&page=1
```

- **检索式放在 URL 路径里**，不是查询参数
- 走 Elasticsearch query_string 语法，**多词必须显式 `AND`**，否则按短语匹配（实测 `feeding frequency grass carp` 只返回 2 条）
- 支持 `bibjson.title:`、`bibjson.year:` 等字段限定
- `bibjson.identifier` 是数组，取 `type === 'doi'` 的那一项
- 收录即 OA，`oaStatus` 可直接标 `doaj-gold`

### CORE

```
GET https://api.core.ac.uk/v3/search/works?q=<检索式>&limit=25&offset=0
Authorization: Bearer <API_KEY>        # 官方要求；实测无 key 也能返回数据
```

- **限流极严**：实测连续两次请求即 429，且会进入较长的冷却期。`api-search.js` 已为 CORE 设置 2500ms 强制最小间隔，并在 429 时退避重试
- 检索语法：**`title:(a AND b)` 有效；`title:"短语"` 会被忽略并退化成全字段检索**（实测 `title:"feeding frequency"` 返回 648093 条，明显未生效）
- 但把 4 个以上词全部 AND 进题名会归零，故脚本在零结果时自动放宽为前两个词
- 默认 `q=` 在整个机构库全文里搜，噪声极大（同一检索词会命中声学、渔业政策等无关文献），**必须收敛字段**
- 长期使用请到 `core.ac.uk/services/api` 注册免费 key，设到 `CORE_API_KEY` 环境变量

### arXiv

```
GET https://export.arxiv.org/api/query?search_query=<式>&max_results=25&sortBy=relevance
```

- **返回 Atom XML**，不是 JSON，需自行解析 `<entry>`
- 字段前缀 `all:` `ti:` `abs:` `au:`；多词必须显式 `AND`
- **整句引号短语几乎必然 0 命中**。实测 `all:"feeding frequency grass carp"` → 0；`all:feeding AND all:frequency` → 804
- 官方要求请求间隔 3 秒，脚本已强制
- 题名检索很宽松，按题名查全文时**必须校验题名相似度**，否则会误匹配

### Unpaywall

```
GET https://api.unpaywall.org/v2/<doi>?email=<你的真实邮箱>
```

- **`email` 是强制参数，且必须是真实邮箱**。实测填占位地址（形如 `you@example.com`）会返回 422：`Please use your own email address`
- 返回 `is_oa`、`oa_status`、`best_oa_location.url_for_pdf`、`oa_locations[]`
- 没有 `email` 时脚本会自动跳过该渠道并在日志中说明

### AGRIS（FAO）

- **不是 JSON API**。`agris.fao.org/search/en?q=` 返回 428 KB 的服务端渲染 HTML，**检索结果与摘要直接内嵌在页面里**，可直接 HTTP 抓取后解析
- `/api/` 路径实测 404；`agris-search/searchIndex.do` 被 Cloudflare 拦
- 水产领域最对口的免费农业科学索引，中文英文文献都收

## 三、源组合建议

| 场景 | 推荐组合 |
|---|---|
| 快速摸底某主题的外文文献 | `openalex,europepmc` |
| 只想要能立刻读到的全文 | `openalex,europepmc,doaj --oa-only` |
| 精确检索（物种 + 指标） | `pubmed --scope title-abs` |
| 找机构库自存版 | `core`（无 key 时会限流，耐心等） |
| 中文课题找外文对照 | `openalex,europepmc`，用英文对照检索词 |
| 学位论文 / 会议论文 | 走中文渠道（万方学位论文、知网会议论文），API 层覆盖不足 |

**默认不必包含 `arxiv`**：实测对水产养殖近乎无用，会白白多一次请求。

## 四、通用礼仪与坑

1. **带 `mailto` / `email`**：OpenAlex 与 Crossref 都据此把你放进 polite pool
2. **遵守间隔**：脚本已内置 `MIN_DELAY`（core 2500ms / arxiv 3000ms / pubmed 800ms），不要改小
3. **遇到 429 要退避**，不要并发重试
4. **分页上限**：OpenAlex `per-page` ≤ 200、Crossref `rows` ≤ 1000、Europe PMC `pageSize` ≤ 1000、DOAJ `pageSize` ≤ 100、CORE `limit` ≤ 100、arXiv `max_results` ≤ 2000
5. **站点被拦 ≠ API 不可用**：OpenAlex、DOAJ、bioRxiv 官网都是 Cloudflare 质询页，但 API 正常
6. **`fetch failed` 通常是网络层不可达**（DNS 或连接被重置），如 Google Scholar、BASE、SSRN、AGRICOLA、FishBase

## 五、作者级检索与姓名匹配

用于“某学者的产出规模、期刊分布、作者位次”这类需求。公开版本不携带特定个人或团队画像缓存；下面的流程应在每次任务中重新取数并披露日期。

**取全量题录**（用 cursor 翻页，不要用 page，避免翻页期间数据变动）：

```
GET https://api.openalex.org/works?filter=author.id:<ID>&per_page=200&cursor=*&select=<见上文可用组合>&mailto=<邮箱>
```

**定位作者号**：`GET /authors?search=<英文名>`，再按 `last_known_institutions` 和目标机构过滤。同一姓名常有多个被合并或错配的档案；应以机构、研究主题、代表作和 `works_count` / `cited_by_count` / `h_index` 同时吻合者为准。

**姓名匹配必须先归一化**——这是最容易静默出错的地方：

- 文献署名可能使用 Unicode 连字符、不同空格或姓/名倒序。先用 `toLowerCase().replace(/[^a-z]/g, '')` 压成紧凑 key，再比对。
- 同时准备正序与倒序 key，并用作者位次、机构和代表作交叉校验。

**作者位次判定**：使用 `authorships[]` 的 `author_position` 与 `is_corresponding`。通讯作者标记覆盖率并非 100%，报告中须披露缺失情况；缺失多时不宜把通讯作者计数当作完整总量。

**区分时间窗口**：署名位次会随职业阶段变化。至少同时给出全量、近 5 年和近 3 年窗口，避免用长期累计掩盖近期变化。

**收录滞后**：OpenAlex/Crossref 对当年论文的索引有数月到一年以上延迟。**当年与上一年的计数会显著低于实际**，报告中必须显式提醒读者不要据此判断产出趋势。
