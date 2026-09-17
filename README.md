# 观众研究隐私治理服务

面向博物馆观众研究同意、数据集谱系和披露控制的 TypeScript 后端服务。

服务在任何新导出发生前核对研究目的、数据来源、同意范围、保留期限、可访问角色与随机参与标识，只交付当前项目允许的最小字段，并在样本低于披露阈值时拒绝出库。方案版本变化会重估既有同意的覆盖性；观众撤回后可定位记录进入删除或不可逆匿名化流程，下游使用者收到处置事项，并留下不含个人数据的合规证明；迟到的离线补传不得重建已撤回身份；数据保护负责人可从任一数据集反查其合法来源、到期动作与全部下游去向。

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动已编译服务。服务默认监听 8000 端口，访问 `GET /health` 可确认进程状态。也可以使用 `docker compose up --build` 启动容器。

运行时状态（含撤回墓碑与审计链）快照写入 `.runtime/state.json`（可用 `STATE_FILE` 覆盖），重启后撤回约束仍然生效。`reference/domain.json` 保存公开的同意状态、数据来源和到期动作枚举，服务启动时加载（可用 `REFERENCE_FILE` 覆盖）。

## 治理模型

- **项目与方案版本**：项目声明研究目的、数据来源、可访问角色、可交付字段、披露阈值、保留期限与到期动作。每次方案变更登记新版本；实质性变更（`requiresReconsent`）使既有同意转入 `restricted`，非实质性变更且范围被覆盖时同意自动延续。
- **同意**：始终绑定项目当前方案版本，范围不得超出版本声明的目的与来源。
- **采集与补传**：撤回墓碑优先于一切——已撤回身份的迟到数据直接丢弃；无覆盖同意的记录进入隔离；保留期已过的数据拒收。
- **导出网关**：依次核对角色、目的、来源、字段最小化（直接标识符永不可交付）、逐条记录的同意覆盖与保留期，最后校验披露阈值（按去重参与者计）。导出行使用按数据集重键控的假名标识，防止跨数据集关联。
- **撤回**：可定位记录按项目策略删除或不可逆匿名化（剥离可识别字段并无映射重键）；受影响数据集（含派生子孙）进入处置流程，全部下游消费者收到处置事项；合规证明只含计数、标识符与密钥散列定位子。
- **谱系**：数据集记录其合法来源（同意与方案版本）、到期动作与全部下游去向（消费者、派生数据集、处置通知），供数据保护负责人反查。
- **审计**：追加式哈希链日志，条目不得包含个人数据（写入时强制校验），`GET /audit/verify` 可重放验证。

## API 概览

请求通过 `x-actor-id` 与 `x-actor-role` 头标识操作者；`/audit*`、`/datasets/:id/lineage`、`/maintenance/retention-sweep` 需要 `data_protection_officer`（或 `system`）角色。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /projects` | 创建研究项目（含初始方案版本） |
| `GET /projects`、`GET /projects/:id` | 项目查询 |
| `POST /projects/:id/protocol-versions` | 登记新方案版本并重估既有同意 |
| `POST /consents` | 登记同意（绑定当前方案版本） |
| `POST /projects/:id/records` | 采集单条记录 |
| `POST /projects/:id/ingest-batch` | 离线批量补传（逐条给出处置结果） |
| `POST /exports` | 导出网关：批准返回数据集（201），拒绝返回原因（403） |
| `POST /datasets/:id/consumers` | 登记下游接收方 |
| `POST /datasets/:id/derive` | 派生数据集（用途漂移被拒） |
| `GET /datasets/:id/lineage` | 反查合法来源、到期动作与下游去向 |
| `POST /withdrawals` | 撤回同意并出具合规证明 |
| `GET /withdrawals/:id/proof` | 查询合规证明 |
| `POST /notices/:id/acknowledge` | 下游确认处置完成 |
| `POST /maintenance/retention-sweep` | 保留期限巡检，执行到期动作 |
| `GET /audit`、`GET /audit/verify` | 审计日志查询与哈希链验证 |
