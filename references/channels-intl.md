# 外文检索渠道矩阵

站点矩阵记录日期：2026-09-16；开放 API probe 复核：2026-10-22。站点状态会变化，缓存有效期按 6 个月处理。外文的价值在于：**大量开放 API 无需任何机构授权即可检索，且有相当比例能直接拿到免费全文**。

## 一、开放 API（零授权，首选）

详见 `references/open-apis.md`。一句话结论：

| 用途 | 首选源 |
|---|---|
| 综合主题检索 | **OpenAlex**（覆盖最广，含 OA 链接、引用数、概念标签） |
| 题录准确性核对 | **Crossref**（DOI 注册机构官方元数据） |
| 水产 / 水生生物 / 营养 | **Europe PMC**（生命科学，OA 全文直链，摘要覆盖好） |
| 精确检索（MeSH、字段限定） | **PubMed** |
| 只想要免费全文 | **DOAJ**（全部为 OA 期刊） |
| 找机构库自存版本 | **CORE** |
| 预印本 | **arXiv**（对水产领域很弱，见第四节） |

## 二、可访问的外文站点

| 站点 | 实测 | 用途 |
|---|---|---|
| `agris.fao.org` | 200，结果内嵌 HTML，**可直接解析** | FAO 农业科学索引，渔业/水产养殖覆盖好，**最对口的免费外文库** |
| `www.fao.org/asfa/` | 200 | ASFA 水产科学文摘（FAO 站，检索入口指向订阅库） |
| `www.scilit.com` | 200 | MDPI 系元数据聚合，适合查开放获取期刊 |
| `www.connectedpapers.com` | 200 | 引文关系图，找「一篇种子文献的相关研究」很高效 |
| `core.ac.uk` | 200 | 机构库聚合，全球开放全文 |
| `oa.mg` | 200 | OA 论文搜索 |
| `openaccessbutton.org` | 200 | 找免费版本的浏览器插件 + 站点 |
| `scholar.archive.org` | 连接失败 | Internet Archive 的学术搜索，本网络不可达 |
| `www.scielo.org` | 200 / 较慢 | 拉美开放获取期刊，水产有部分收录 |
| `www.jstage.jst.go.jp` | 200 / 很慢 | 日本科学技术信息，水产养殖有日本文献 |

## 三、实测被拦的外文站点

| 站点 | 现象 | 处置 |
|---|---|---|
| Google Scholar | 连接失败 | 放弃。用 OpenAlex / Crossref 替代其检索功能 |
| ResearchGate | 403 | 放弃机器访问，人工查作者自存版 |
| Dimensions | 403 | 放弃 |
| Lens.org | 405 | 放弃 |
| OpenAIRE 站点 | 403，但 **API 可用**（`api.openaire.eu` 返回 XML） | 走 API |
| BASE | 连接失败（且需注册 IP） | 放弃 |
| SSRN | 连接失败 | 放弃；社会科学预印本与本领域关系不大 |
| AGRICOLA / PubAg | 连接失败 / 202 壳 | 用 AGRIS 替代（同为农业索引，且可达） |
| FishBase | 连接失败 | 物种生物学数据，非文献库；需用时人工访问 |
| Semantic Scholar | 站点 202 壳；**API 429 限流** | API 需申请 key 才能稳定使用 |

注意一个反复出现的模式：**站点被 Cloudflare 拦（403「Just a moment...」）不等于 API 不可用**。OpenAlex、DOAJ、bioRxiv、ChemRxiv 的官网都返回 Cloudflare 质询页，但它们的 API 全部正常返回 JSON。判定渠道可用性时必须分别测站点和 API。

## 四、各源的适用边界（按水产营养课题）

| 源 | 强项 | 弱项 / 注意事项 |
|---|---|---|
| OpenAlex | 覆盖面最广；`search` 自然语言好用 | 部分记录无摘要；`openalex.org` 官网被 Cloudflare 拦，只能走 API |
| Crossref | 题录最权威；支持按 DOI 精确取 | **摘要覆盖不全**；会混入「Figure 1:」这类图片组件条目（脚本已自动过滤）；`link` 字段是出版商地址、不代表免费 |
| Europe PMC | 生命科学/水产覆盖好，题录页/PDF 直链齐全 | 默认全字段检索精度很差（实测 "feeding frequency grass carp" 返回心血管病综述），**必须收敛到题名+摘要**（脚本已默认如此） |
| PubMed | MeSH 词表、字段限定语法强大，适合精确检索 | 无摘要（脚本已用 efetch 补齐）；检索范围偏医学，纯养殖类文献少 |
| DOAJ | 100% 开放获取，摘要完整 | 只收 OA 期刊，覆盖量有限 |
| CORE | 能挖到机构库里的作者自存版全文 | 元数据质量参差；默认全文检索噪声极大（脚本已收敛到题名）；**限流极严，无 key 时连续请求即 429** |
| arXiv | 物理/数学/CS 预印本 | **对水产养殖极弱**：实测 `all:feeding AND all:frequency AND all:carp` 命中 0。除非课题涉及模型、算法、生物信息，否则不必纳入默认源 |

## 五、订阅型专业库（了解即可，需机构授权）

这些库在校园网外无法使用，但知道它们存在有助于判断「是否漏检」：

| 库 | 覆盖 |
|---|---|
| **ASFA**（Aquatic Sciences and Fisheries Abstracts） | 水产科学文摘，本领域最专业的抽象库，ProQuest 平台 |
| **AGRIS / AGRICOLA** | 农业科学索引（AGRIS 免费可达，AGRICOLA 本网络不可达） |
| **CAB Abstracts** | 农学、兽医学、营养学的经典文摘库 |
| **FSTA** | 食品科学与技术文摘 |
| **BIOSIS Previews / Zoological Record** | 生物学与动物学 |
| **Web of Science / Scopus** | 引文索引与期刊分区，用于判断期刊层级 |
| **Fish & Fisheries Worldwide** | 渔业专题 |

进校后这些多为已购资源，用它们做**最终复检**，避免因免费渠道覆盖面不足而漏检。

## 六、外文检索式写法差异

| 源 | 语法要点 |
|---|---|
| OpenAlex | `search=` 支持自然语言与布尔；也可用 `filter=title_and_abstract.search:xxx` 限定字段 |
| Crossref | `query.bibliographic=` 匹配题名+作者+刊名；`query.title=` 仅题名；**无摘要字段检索** |
| Europe PMC | 字段前缀 `TITLE:` `TITLE_ABS:` `AUTH:` `JOURNAL:`；`OPEN_ACCESS:Y` 限定 OA |
| PubMed | `"term"[Title/Abstract]`、`term[MeSH Terms]`、`AND/OR/NOT`、`2020:2026[dp]` 年份 |
| DOAJ | Elasticsearch query_string，多词需显式 `AND`；支持 `bibjson.title:` 等字段 |
| CORE | `title:(a AND b)` 有效；**`title:"短语"` 会被忽略退化成全字段检索** |
| arXiv | 字段前缀 `all:` `ti:` `abs:`，多词需 `AND`，整句短语几乎必然 0 命中 |

`api-search.js` 已按源自动做归一化（见脚本内 `normalizeQuery` 与 `scopeTerms`），但**如果你传入显式检索语法（含引号、括号、`AND`），脚本会原样透传**，此时按上表自己写。
