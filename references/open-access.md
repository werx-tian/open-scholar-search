# 开放获取（Open Access）获取渠道

目标：把「检索到的题录」尽可能变成「能读到全文」。按成本从低到高排列。

## 一、决策路径

```
有 DOI？
├─ 有 → oa-resolve.js（OpenAlex 批量 → Unpaywall → Europe PMC）
│         └─ 仍无 → 按题名查机构库（CORE / OpenAIRE）
│                  └─ 仍无 → 查预印本（arXiv / ChinaXiv / bioRxiv）
│                           └─ 仍无 → 仍拿不到，走人工路径（见第五节）
└─ 无 → 用题名检索 Europe PMC / CORE / AGRIS
```

一条命令跑完前三级：

```bash
node oa-resolve.js -i records.jsonl -o with-oa.jsonl --email <你的邮箱> --report
```

逐条补查默认使用 5 路有界并发，但 Unpaywall、Europe PMC、arXiv 各自串行限速。可用 `--concurrency` 调整总并发；不要把多个来源的限流额度当成一个共享额度。

`--email` 是必需的：Unpaywall 强制要求真实邮箱（实测填 `example.com` 会返回 422 并提示 "Please use your own email address"），OpenAlex 也用它进入 polite pool 降低被限流概率。

## 二、预印本平台

预印本是最快、最无门槛的免费全文来源，但**未经同行评审**，引用时需说明版本。

| 平台 | 实测 | 覆盖 |
|---|---|---|
| **arXiv** `arxiv.org` | 站点 200；API 200（Atom XML） | 物理、数学、CS、量化生物学。**水产养殖极弱**，除非课题涉及模型/算法/生信 |
| **bioRxiv** `www.biorxiv.org` | 站点被 Cloudflare 拦；**API 正常** `api.biorxiv.org/details/biorxiv/<doi>` | 生命科学预印本，包含鱼类生物学、水生毒理 |
| **medRxiv** `www.medrxiv.org` | 站点 200 | 医学预印本，与营养学交叉课题可用 |
| **ChemRxiv** `chemrxiv.org` | 站点被 Cloudflare 拦 | 化学预印本，饲料化学相关 |
| **Preprints.org** | 站点 200 | 多学科，门槛低数量杂 |
| **OSF Preprints** `osf.io/preprints` | 站点 200 | 多学科，含研究方法与数据论文 |
| **ChinaXiv** `www.chinaxiv.org` | 站点 200 | **中科院中文预印本平台**，查中文预印本用这个 |
| **SSRN** | 连接失败 | 社科为主，本领域无关 |

bioRxiv 的 API 用法（无需 key）：

```
https://api.biorxiv.org/details/biorxiv/<doi>
```
返回 `collection` 数组，含 `title`、`authors`、`doi`、`date`、`published`（若已正式发表会给出期刊 DOI）。注意：**未收录的 DOI 返回 `{"messages":[{"status":"no posts found"}]}`，不是报错**，解析时不要当成失败。

## 三、机构知识库与聚合器

作者常把已发表论文的自存版（accepted manuscript）放进机构库，这是拿全文的稳定途径。

| 渠道 | 实测 | 用法 |
|---|---|---|
| **CORE** `core.ac.uk` | 站点 200；API 200（**无 key 也能返回数据**，但官方要求注册） | 全球机构库聚合，`downloadUrl` 常直接指向免费 PDF。**限流极严**，无 key 时连续请求即 429 |
| **OpenAIRE** `api.openaire.eu` | 站点 403，**API 200（XML）** | 欧盟开放科学聚合器，含项目资助信息 |
| **BASE** | 连接失败 | 需注册 IP，本网络不可用 |
| **中科院机构知识库 IR GRID** `www.irgrid.ac.cn` | 连接失败 | 改用 CORE / OpenAIRE 间接覆盖 |
| **PubAg**（USDA 国家农业图书馆） | 202 壳 | 用 AGRIS 替代 |
| **Zenodo** `zenodo.org/api/records` | API 200 | 通用仓储，含数据论文、软件、会议材料 |
| **DataCite** `api.datacite.org/dois` | API 200 | 数据集 DOI 注册机构，查数据论文 |
| **SciELO** `www.scielo.org` | 站点 200（较慢） | 拉美开放获取期刊 |

## 四、开放获取期刊与目录

| 渠道 | 说明 |
|---|---|
| **DOAJ** `doaj.org` | 开放获取期刊目录，**收录即意味着全文免费**。API 可检索且返回完整摘要 |
| **COAJ** `www.coaj.cn` | 中国科技期刊开放获取平台 |
| **中国科技论文在线** `www.paper.edu.cn` | 教育部主管，中文论文全文免费 |
| **国家哲学社会科学文献中心** `www.ncpssd.org` | 人文社科免费全文（水产课题一般用不上） |
| **OA.mg / Open Access Button / CORE Discovery** | 输入 DOI 或题名自动找免费版本的站点与浏览器插件 |

OA 状态术语（`oaStatus` 字段取值）：

| 取值 | 含义 |
|---|---|
| `gold` | 金色 OA：期刊本身开放获取，出版商官网即可免费读 |
| `hybrid` | 混合 OA：订阅期刊中的单篇付费开放 |
| `bronze` | 青铜 OA：出版商官网可免费读，但无开放许可 |
| `green` | 绿色 OA：作者自存版在机构库或预印本平台 |
| `repository` | 机构库版本（CORE 等给出的） |
| `pmc-fulltext` / `europepmc-pdf` | 在 PMC 或 Europe PMC 有免费全文 |
| `closed` | 无免费全文，需订阅 |

**重要**：`oaStatus=closed` 的记录没有任何免费全文链接，导出时「全文链接」列会留空。若发现某条 closed 记录带了链接，那是 bug，应及时报告。

## 五、拿不到全文时的人工路径（合法）

1. **校园网 / 机构 VPN** — 学校已购库的正当用法，最省事
2. **NSTL 文献传递** — `www.nstl.gov.cn` 注册后按篇申请，费用低、合法
3. **图书馆馆际互借（ILL）** — 通过本校图书馆提交申请
4. **向作者索取** — 通讯作者邮箱通常在题录页或期刊页给出；也可用 ResearchGate 的 "Request full-text"
5. **期刊官网过刊** — 部分期刊（尤其中国期刊）在官网免费放 PDF 或 HTML 全文
6. **更换来源重检** — 同一篇研究可能有预印本、会议版、学位论文版、中文改写版，用题名在 CORE / ChinaXiv / 万方检索

**不要使用 Sci-Hub 等盗版镜像。** 它们绕过出版商授权，存在法律风险与恶意软件风险，也可能影响课题组成果的正常发表。本 skill 收录的全部渠道均为合法来源。

## 六、文献管理与批量下载

- **Zotero** — 免费开源。导入本 skill 导出的 BibTeX 或 CSV 即可建立库
  - *Jasminum（茉莉花）* 插件：抓取知网中文题录元数据
  - *Better BibTeX* 插件：稳定的引用键与自动导出
  - *ZotFile / Attanger* 插件：PDF 自动重命名与归档
- **EndNote / NoteExpress** — 学校多已购买，NoteExpress 对中文文献支持更好
- 本 skill 导出的 CSV 含「开放获取」「全文链接」两列，可先按这两列筛出能立即读的文献，再逐篇下载
