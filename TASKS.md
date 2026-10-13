# 日报、周报生成与 GitHub 发布

本项目是账户所有者已授权发布真实数据的公开版本。目标仓库为 `Anna0715/ibkr-dashboard-web`，分支为 `main`，网页为 https://anna0715.github.io/ibkr-dashboard-web/ 。继续使用当前七栏目、深色紫色布局、图表、日期筛选和股票分析定位。原站点及 Agent-report 仓库均不是发布目标。

## 执行顺序

1. 当次只读 IBKR 持仓、订单、摘要、余额、PortfolioAnalyst、成交、自选列表和每个自选分组；重新识别“等待买点”。采集市场日线、公司公告、宏观、资金流和宽度来源。所有数据单独记录读取时间、市场日期、常规收盘/实时/延迟状态。
2. 核实最近已完成的美东常规收盘和下一实际交易日。生成完整中文分析，保存七栏目 `market/portfolio/holdings/analysis/trades/stocks/watchlist`。公司主分析按持仓 > 挂单 > 等待买点 > 其他关注去重；订单逐笔保留。固定观察池来自当前 `reports.json.fixedPool`，并与当次全部自选取并集。
3. 对资金流、NYSE/Nasdaq 涨跌家数/新高新低、财报预期与指定时间窗 SEC 事件分别列实际覆盖、来源、日期、缺项及影响。没有数据不能填零，量价代理不能充作真实资金净流量或市场宽度。只给有依据的条件建议，不执行交易。
4. 读取 GitHub 最新 `main` 提交及对应的 `reports.json`，在该版本上追加候选日报/周报。调用 `scripts/report-pipeline.mjs` 校验和准备文件。程序只处理已经采集、分析并清洗的结果，不承担证券研究，不自动登录券商，不发出交易。
5. 一次提交新 `reports.json`、新增归档附件及真正取得更新的 `data.json/market.json`。旧报告完整保留，相同内容重试不新增，修订另存版本。通过 GitHub 连接的创建 tree、创建 commit、更新 branch 功能提交；parent 和 expected head 使用刚读取的 main，禁止强推。发生并发冲突重新读取最新版本再合并。结果不明先检查远端新增 record 的内容哈希，再决定是否重试。
6. 检查该提交的 Pages 部署状态，并从线上 `reports.json` 验证新增报告 id、内容哈希及归档文件。只有线上一致才能回复“网页已更新”。提交成功但线上尚未更新时，分别报告两项状态。
7. 每次最终回复包含决策摘要、收盘/报告日期、持仓及订单重点、覆盖缺口、报告附件、网页链接和发布状态。生成报告成功、发布失败时仍交付完整报告，明确失败环节；不得只返回旧网页链接。

## 输入与原始报告

程序使用 Node.js 18 或以上，无第三方依赖。任务运行环境应从本仓库当前版本读取程序；不用本机绝对路径，不依赖上一次临时容器，不把认证令牌写进仓库或任务说明。

```sh
node scripts/report-pipeline.mjs --root . --input candidate.json --check
node scripts/report-pipeline.mjs --root . --input candidate.json
```

输入对象为 `{record, data?, market?, archiveHtml?}`。`record` 的实际校验规则以程序为准。必需信息包括：

- `type: daily | weekly`，`periodStart/periodEnd`，`reportDate`，`closeDate`，带时区的 `capturedAt/cutoff`，`version`，`title`，真实 `completeness`，`sourceNote`。
- 日报日期按美东收盘日组织，报告生成日独立列出；休市期间的新信息作为明确标注的同收盘日修订，不伪装新增收盘。
- 七栏目各含 `title` 和 `blocks`。block 为 `heading/paragraph/list/table`；表格列数必须一致。股票标题采用 `SYMBOL · 行业或主题`，确保自动生成对应定位入口。行情表用 `证券/1D/5D/1M`，持仓表保留 `收盘重估市值/重算浮盈/重算日损益`，以复用当前图表。
- `evidence` 为来源数组，每项含唯一 `id`、`source`、带时区的 `capturedAt`、`asOfDate`，以及公开 `url` 或实际连接 `tool`。`coverage` 含 `missing: [缺口说明]` 与 `sections: {market: {status, evidenceIds}, ...}`，七栏目各列 `complete/partial/missing` 状态和对应来源 id。允许标明缺口的 partial 报告；完整栏目不等于数据与研究全面完成。
- `id/date/frequency/format/kind/weekEnd/sourceCapturedAt/originalReportPath/pipeline/revisionOf` 为程序输出字段，不能手动写入候选 `record`。`version` 是申请版本下限，程序遇历史修订会自动递增。
- 附件由已验证 blocks 安全生成或提供通过检查的 HTML；归档路径由程序生成，不能指定任意仓库路径。保留报告对应的账户快照及市场口径。

账户编号、订单/成交的真实内部编号、姓名、邮箱、令牌、密码及后台配置必须先剥离。逐笔订单使用报告内编号，合约身份可保留。不得上传未清洗的 IBKR 原始响应。

## 更新有效快照

`data.json` 与 `market.json` 必须保持现有结构及实际来源日期。账户核心接口失败时不要覆盖上一份有效账户快照；报告内写清失败和旧快照日期。空持仓或空成交必须有当次成功读取的证据。可选快照含 `sourceEvidence`：账户的 `summary/positions/balances/performance`、市场的每个可用证券代码，各提供 `{status: "success", evidenceId: "record.evidence中的实际来源id"}`；对应来源的读取时间与数据日必须匹配快照元信息。程序拒绝空对象、缺核心结构或把旧历史数据改成新日期的快照。市场数据尚未取得最新日期时保留旧日期，不挪成今天。财务数字缺失保留 null 或说明，不擅自归因估值差额。

## 综合周报

周报生成独立七栏目正文，保存 `frequency: weekly`、`kind: weekly-report`、`format: narrative`、`date: periodStart`、`weekEnd: periodEnd`、本周实际 `tradingDates`、已读取的 `sourceRecordIds` 和明确的缺报日期。`coverage` 另列 `tradingDays/coveredDays/missingDays/calendarEvidenceId/returnMethod`，实际收益算法为 `twr/compound/endpoint-ratio/not-calculated`。交易日清单由交易所日历核实，不用七个日历日冒充七个交易日。若日历不可取得，允许明确 partial 周报：`coverage.tradingDatesVerified: false`、三个 day 数组为空、`calendarEvidenceId: null`、`returnMethod: "not-calculated"`，并在 `missing` 列明日历未核验；程序不会凭日历天数推造缺报天数。缺日报时继续结合实际周行情生成综合周报，列明历史账户归因限制。

周收益取前周最后收盘至本周最后收盘，使用官方绩效周期或一致日收益链式计算；不能直接相加日收益率，不能用当前仓位倒推历史归因。正文包含本周驱动与转折、板块及宽度、账户表现、逐股逻辑变化、逐笔订单、本周建议验证和下周事件/Top10/五信号。浏览器自动形成的一周日报清单仅为归档汇集，不是正式综合周报。

## 运行状态

静态网页本身不会查询账户或触发研究。触发器使用账户所有者既有的 ChatGPT 云端日报、周报任务。连接工具的可用性、自动批准、任务完成通知与手机系统权限由任务运行环境决定；必须依据实际运行和线上结果报告状态，不能把修改任务说明当成成功完成了一次自动发布。
