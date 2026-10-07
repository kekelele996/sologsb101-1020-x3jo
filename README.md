# 碑帖拓片编目与版本比对台（gbrubbing）

面向碑刻拓片收藏机构编目员的本地化工具：把同一碑刻的不同拓本编目登记，标注损泐字位并做版本差异比对与断代辅助判断。

核心动作：**建立碑刻与所在地档案 → 登记拓本的拓法与纸墨尺寸钤印 → 逐行标注损泐字位 → 执行同碑多版本比对与断代 → 库房按实测尺寸装箱排架（装具/柜位层）→ 导出编目卡**。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Redux Toolkit + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据）。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22820**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbrubbing}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、字位网格、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22820 |
| 状态管理 | Redux Toolkit 2 + React Redux 9 | `steleSlice` / `rubbingSlice` / `lossSlice` + `store.ts` 类型化 hooks |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22820
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22820）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/steles` | 碑刻与所在地台账 | 新建碑刻、按年代与形制筛选（同步 URL query），卡片回显已收拓本数、损泐字位与最近断代结论 | Stele、Rubbing、Loss、Compare |
| `/rubbings` | 拓本登记 | 录入拓法、纸墨、尺寸与收藏号；同碑自动生成版本序号，钤印增删改与批量调整印别，批量改状态，并回显库房装具号与实测尺寸 | Rubbing、Seal、Stele、Shelf |
| `/shelves` | 库房排架台 | 排架账对账（库房实测尺寸为准、认不出的收藏号挂待认领）、按尺寸合计上限装箱、每层定数摆装具、写库失败只重试这一个装具、留待上架补测重分 | Shelf、Rubbing |
| `/losses` | 损泐字位标注台 | 行号 × 字位网格逐格标注，批量改严重程度；选定基准拓本即时高亮差异字位 | Loss、Rubbing |
| `/compare` | 同碑多版本比对与断代 | 选定 A/B 两拓本，按字位坐标比对损泐集合并排展示差异，推断早本 / 晚本 / 同版 / 待考并落库 | Compare、Loss、Rubbing |
| `/export` | 编目卡生成与导出 | 按碑刻生成编目卡文本、合订导出、钤印明细、JSON 导入导出、损泐台账 CSV、库房排架账 CSV、清空重播种 | 全部模型 |

`/` 与未匹配路径重定向到 `/steles`。筛选条件写入 URL query（`?kw=&method=&state=` 等），可直接分享带条件的链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Stele 碑刻 | `src/types/stele.ts` | `id` `title` `era` `location` `form`（碑/碣/摩崖/墓志） `sizeCm` `calligrapher` | 新建后进入拓本登记，卡片回显拓本数与差异条数 |
| Rubbing 拓本 | `src/types/rubbing.ts` | `id` `steleId` `versionNo` `method`（擦拓/扑拓/蝉翼拓） `paperType` `inkTone`（浓墨/淡墨） `sizeCm` `collectionNo` `dateGuess` `state`（待编目/已编目/待比对） | 同碑多份并存，版本序号自动生成 |
| Loss 损泐字位 | `src/types/loss.ts` | `id` `rubbingId` `lineNo` `charNo` `type`（缺字/裂痕/漫漶/石花） `severity`（轻/中/重） `note` | 按行列网格标注，同碑同字位自动并排对比 |
| Seal 钤印 | `src/types/seal.ts` | `id` `rubbingId` `sealText` `position` `transcription` `sealType`（收藏印/鉴赏印/作者印） | 按位置排序展示，支持批量改印别 |
| Compare 版本比对 | `src/types/compare.ts` | `id` `steleId` `rubbingIdA` `rubbingIdB` `diffCount` `conclusion`（早本/晚本/同版/待考） `operator` `date` | 选定两拓本即生成差异清单并回写断代结论 |
| ShelfLayer 柜位层 | `src/types/shelf.ts` | `id` `seq` `name` `slotCount`（每层定死的装具数） `slotsUsed` | 装具摆满一层自动开下一层，写库失败装具也占槽不腾位 |
| Container 装具 | `src/types/shelf.ts` | `id` `code`（装具-001） `sequenceNo` `bucket`（大/中/小件） `sizeLimitCm` `totalSizeCm` `layerId` `slotNo` `status`（在架/写库失败） `attempts` `lastError` | 尺寸合计有上限，放不下另起一个；写库失败只挂起并重试这一个装具 |
| ShelfEntry 排架账条目 | `src/types/shelf.ts` | `id` `collectionNo` `rubbingId` `measuredSizeCm`（库房实测） `catalogSizeCmSnapshot`（编目量得留底） `bucket` `containerId` `status`（待装具/已上架/待认领/留待上架/写库失败） | 库房排架账与编目台对账：尺寸以库房为准，认不出的收藏号单独挂待认领 |

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`。`v1→v2` 为 `losses` 表增加 `charNo` 与 `[rubbingId+lineNo+charNo]` 复合索引，并在 Dexie `.upgrade()` 中按行号顺序为历史字位记录重建 `charNo`；`v2→v3` 新增 `shelfLayers` / `shelfContainers` / `shelfEntries` 三张排架表，**旧拓本没有装具号，升级时按编目尺寸先粗分（高 ≥240 大件 / ≥180 中件 / 其余小件）记为待装具，尺寸缺记或不可辨的留待上架**，库房实测留空待排架账对账时回填。

---

## 六、目录结构

```
sologsb101-1020/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # stele.ts rubbing.ts loss.ts seal.ts compare.ts shelf.ts
│   │   ├── stores/               # steleSlice.ts rubbingSlice.ts lossSlice.ts shelfSlice.ts store.ts
│   │   ├── components/common/    # LossTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
│   │   ├── hooks/                # useLossDiff.ts useIdbTable.ts
│   │   ├── pages/                # SteleList.tsx RubbingList.tsx ShelfBoard.tsx LossBoard.tsx CompareView.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # collate.ts shelfPack.ts shelfGateway.ts db.ts export.ts
│   │   ├── styles/               # main.css
│   │   ├── App.tsx main.tsx
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面通过 `useSelector` / `dispatch` 读写 Redux，跨页状态不留在组件内部 `useState`；IndexedDB 读写由 slice 的 `createAsyncThunk` 统一封装，页面级只读订阅（如钤印明细）走 `useIdbTable()` 的 `liveQuery`；字位坐标编解码与差异算法集中在 `utils/collate.ts`，比对派生逻辑走 `useLossDiff()`；排架装箱规则（尺寸解析、粗分桶、装具上限顺装、每层定数开层）集中在 `utils/shelfPack.ts` 纯函数，库房写库与按装具失败隔离 / 重试集中在 `utils/shelfGateway.ts`。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbrubbing`）**：8 张业务表 `steles` / `rubbings` / `losses` / `seals` / `compares` / `shelfLayers` / `shelfContainers` / `shelfEntries`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 首次打开时自动播种**三层互相引用**的演示数据（Stele → Rubbing → Loss / Seal，另有 Stele → Compare、Rubbing → ShelfEntry → Container → ShelfLayer，固定 id 如 `stele_01`、`rub_0101`、`loss_010101`、`装具-001`），播种幂等，保证字位网格、比对台与排架台打开即有内容。
- **排架账与编目台的边界**：库房按收藏号对账，库房实测尺寸与编目员量得不一致时**只覆盖拓本尺寸一个字段**（编目量得尺寸留底在排架条目的 `catalogSizeCmSnapshot`），拓法、纸墨、损泐字位、断代结论一律不动；认不出对应拓本的收藏号单独记为待认领（`pendingClaim`），等人在排架台认领到拓本；尺寸缺记 / 不可辨 / 单件超装具上限的条目录为留待上架（`pendingShelf`），补测后重新粗分。装具按桶（大 / 中 / 小件）顺装：尺寸合计不超上限就继续放，放不下另起装具，每层摆够定数自动开下一层；库房写库失败**只挂起并重试这一个装具**（失败也占槽不腾位），其余装具照常上架，编目台表不参与写库事务、不回滚。纯前端无真实库房服务，`shelfGateway` 提供「下一装具失败一次 / 持续失败」故障注入开关用于演示该隔离与重试行为。
- **localStorage**：仅存元数据 —— `gbrubbing:db-version`（本地结构版本）、`gbrubbing:last-backup-at`（最近导出时间）、`gbrubbing:ui-prefs`（当前碑刻 / 拓本）。
- **备份**：`/export` 页可导出 JSON（8 张表全量数据 + 结构版本号；旧版备份缺排架三表时按空集合兼容导入），导入时校验 `app` 字段与各集合数组完整性，覆盖导入前二次确认；另有编目卡 TXT、损泐台账 CSV 与库房排架账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22820`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbrubbing` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
