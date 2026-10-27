# 检索式构造细则

## 1. 知网字段代码

专业检索框（`SU=... AND ...` 那种写法）可用字段：

| 代码 | 含义 | 使用建议 |
|---|---|---|
| `SU` | 主题（题名+关键词+摘要综合） | **默认首选**，召回与精度平衡最好 |
| `TI` | 篇名 | 已知确切题名、或需要强精度时 |
| `KY` | 关键词 | 作者标引词，比 SU 精准但可能漏 |
| `AB` | 摘要 | 找方法/结论层面的表述时 |
| `FT` | 全文 | 召回最全但噪声大，仅在别处查不到时用 |
| `AU` | 作者 | 追某团队产出（如 `AU=周小秋`） |
| `FI` | 第一作者 | 需要排除通讯作者干扰时 |
| `AF` | 机构 | 如 `AF=四川农业大学` |
| `LY` | 文献来源（期刊名） | 补漏特定期刊 |
| `FU` | 基金 | 找基金项目产出 |
| `DOI` | DOI | 精确定位 |
| `YE` | 年 | `YE=2020-2026` |

## 2. 运算符

| 写法 | 含义 |
|---|---|
| `*` 或 `AND` | 逻辑与，缩窄 |
| `+` 或 `OR` | 逻辑或，扩展 |
| `-` 或 `NOT` | 逻辑非，排除 |
| `()` | 优先级分组，**必须用半角括号** |
| `*` / `?` | 仅在部分字段支持通配；中文检索意义不大，慎用 |

**易错点**：从 Word / 微信里复制来的检索式常带全角括号 `（）` 和全角空格，直接粘进专业检索框会报语法错误。粘贴后先全文替换为半角。

## 3. 同义词词表模板

同义词是检索质量的分水岭。构造检索式前先填这张表，**每个维度至少 3 个同义表述**。

```
课题：____________________________________

对象词（研究客体）
  正式名：____________
  俗称 / 别名：____________
  上位概念（科 / 属 / 食性大类）：____________
  英文：____________

处理词（自变量 / 干预）
  规范表述：____________
  文献中出现的其他写法：____________ / ____________
  英文：____________

指标词（因变量 / 结局）
  生长类：____________
  利用效率类：____________
  生理 / 健康类：____________
  英文：____________

限定条件
  来源类别：北大核心 / CSCD / SCI
  年份区间：____________
  学科：____________
```

### 已填示例（水产营养）

| 维度 | 同义词 |
|---|---|
| 投喂频率 | 投喂频率 / 投喂次数 / 日投喂次数 / 给食频率 / 摄食频率 / feeding frequency |
| 生长性能 | 生长性能 / 生长指标 / 增重率 / 特定生长率 / 日增重 / WGR / SGR |
| 饲料利用 | 饲料系数 / 饲料转化率 / 饵料系数 / 蛋白质效率 / FCR / PER |
| 养分吸收 | 表观消化率 / 消化率 / 消化酶 / 肠道吸收 / ADC |
| 对象（无胃鱼） | 草鱼 / 鲫 / 鲫鱼 / 团头鲂 / 罗非鱼 / 鲤科 |

### 中英对照词表（水产动物营养）

中文库与外文库的检索必须**分别用各自语言重跑**，两边的文献几乎不重叠。以下为常用对照，可直接填进词表：

| 维度 | 中文 | 英文 |
|---|---|---|
| 对象 | 草鱼 / 鲫 / 团头鲂 / 罗非鱼 / 花鲈 / 大口黑鲈 / 黄颡鱼 | grass carp / crucian carp / blunt snout bream / Nile tilapia / Japanese seabass / largemouth bass / yellow catfish |
| 食性分类 | 无胃鱼 / 有胃鱼 / 肉食性 / 杂食性 | agastric fish / gastric fish / carnivorous / omnivorous |
| 投喂 | 投喂频率 / 投喂水平 / 饱食投喂 / 限制投喂 | feeding frequency / feeding rate / satiation feeding / restricted feeding |
| 营养 | 蛋白源替代 / 鱼粉替代 / 豆粕 / 菜粕 | protein source substitution / fishmeal replacement / soybean meal / rapeseed meal |
| 生长 | 生长性能 / 增重率 / 特定生长率 | growth performance / weight gain rate / specific growth rate (SGR) |
| 利用效率 | 饲料系数 / 饲料转化率 / 蛋白质效率 | feed conversion ratio (FCR) / feed efficiency ratio (PER) |
| 消化吸收 | 表观消化率 / 消化酶活性 / 肠道吸收 | apparent digestibility coefficient (ADC) / digestive enzyme activity / intestinal absorption |
| 健康 | 抗氧化能力 / 免疫指标 / 肠道菌群 | antioxidant capacity / immune parameters / gut microbiota |
| 代谢 | 肝体比 / 脏体比 / 体脂沉积 | hepatosomatic index (HSI) / viscerosomatic index (VSI) / lipid deposition |

英文检索时**优先用缩写**（SGR、FCR、ADC、HSI、VSI），因为英文摘要里缩写出现频率远高于全称。

### 3.1 结构化词表

机器检索优先读取 `references/synonyms.json`，避免同义词只停留在说明文档里：

```json
{
  "规范词": {
    "synonyms": ["中文异名"],
    "latin": "Scientific name",
    "english": "English term"
  }
}
```

`api-search.js --synonyms references/synonyms.json` 会分别生成中文 OR 组与英文对照式。人工填充时仍应覆盖异体字、误写、缩写和常用译名；不要把高度泛化的上位词直接塞进 L0 同义组。

## 3.5 跨平台检索式迁移

**检索式不能跨平台复制**，字段代码与算子写法各不相同。迁移方法：

1. 先用 SKILL.md 的三段式骨架把词拆成「对象 / 处理 / 指标」三组
2. 按目标平台语法重新组装

| 平台 | 布尔 | 字段限定 |
|---|---|---|
| 知网专业检索 | `AND` `OR` `NOT`，或用 `*` `+` `-` | `SU=` `TI=` `KY=` `AB=` `AU=` `LY=` `FU=` `DOI=` |
| 万方 | `*`(与) `+`(或) `-`(非) | `题名:` `关键词:` `摘要:` `作者:` `期刊名:` |
| 维普 | `*` `+` `-` | `T=`(题名) `K=`(关键词) `M=`(摘要) `A=`(作者) |
| OpenAlex | 自然语言或布尔 | `filter=title_and_abstract.search:<词>` / `title.search:` |
| Crossref | 自然语言 | `query.bibliographic=` / `query.title=`，**无摘要字段** |
| Europe PMC | `AND` `OR` `NOT` | `TITLE:` `TITLE_ABS:` `AUTH:` `JOURNAL:` `OPEN_ACCESS:Y` |
| PubMed | `AND` `OR` `NOT` | `[Title/Abstract]` `[MeSH Terms]` `2020:2026[dp]` |
| DOAJ | **多词必须显式 `AND`** | `bibjson.title:` `bibjson.year:` |
| CORE | `AND` | `title:(a AND b)`。**`title:"短语"` 会被忽略** |
| arXiv | `AND` `OR` `ANDNOT` | `all:` `ti:` `abs:` `au:`，整句短语几乎必然 0 命中 |

`scripts/api-search.js` 会自动做上述适配（自然语言检索词 → 各源语法）；但**一旦你传入含引号、括号或 `AND` 的显式语法，脚本会原样透传**，此时按上表自行书写。

## 4. 调优流程

1. **裸跑**：只填核心对象词 + 处理词，观察规模
2. **加指标词**：结果量掉到 50~300 条为理想区间
3. **加限定**：来源类别 → 年份 → 学科，逐层加，每加一层记录结果数
4. **查 0 结果**：按 **指标词 → 处理词 → 对象词** 顺序放宽。指标词最容易出问题——文献里可能用"增重率"而不是"生长性能"
5. **查爆炸**：把 `SU` 换成 `TI`，或把处理词收成精确表述
6. **中英分流**：中文库与 SCI 库分别检索，英文用英文词表重跑一遍

## 5. 检索式归档

每条交付的检索式都要能原样复用，记录格式：

```
#  课题：
#  库：CNKI / 万方 / NSTL
#  限定：来源类别=____，年份=____
#  检索式：SU=(...) * SU=(...) * SU=(...)
#  结果数：____（____日期）
#  备注：
```
