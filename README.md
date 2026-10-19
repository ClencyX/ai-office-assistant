# AI辅助办公应用

一期是一个中文本地办公任务管理平台，适合个人记录任务、跟踪交付和管理周期工作。前端使用原生 HTML、CSS 和 JavaScript，服务端使用 Node.js 内置 HTTP 与 SQLite，应用无需安装第三方依赖。

## 已有功能

- 工作总览、任务台账、列表与看板，支持搜索、筛选和分页查看全部任务。
- 新建、编辑、改派、开始处理、完成和重新打开任务；所有状态均可编辑。
- 按文本、表格、演示文稿、PDF、图片或不限设置提交形式，完成任务前必须上传符合格式的交付材料。
- 已提交材料下载、任务操作历史、删除确认、回收站与恢复。
- 每周、每月、每季度、每年固定任务，支持 CSV 批量导入。
- 临期、到期和逾期站内提醒，任务台账导出与 SQLite 数据备份。
- 简洁中文页面，适配桌面与窄屏。

当前版本默认供本机管理员单人使用，业务页面仅监听本机地址。负责人用于任务归属和提醒标注，目前没有独立用户登录、多人权限、外部消息投递或 AI 文档生成。无需模型账号和接口密钥。GitHub 上的代码协作与应用内多人共同办公是两件独立的事。

## 获取代码

在仓库页面点击 **Code → Download ZIP** 下载后解压，或复制仓库的 HTTPS 地址进行克隆：

```sh
git clone https://github.com/yinghuili625/ai-office-assistant.git
cd ai-office-assistant
```

下面所有命令都在包含 `package.json` 的项目目录执行。

## 本地运行

安装 [Node.js 24 或以上版本](https://nodejs.org/)，然后运行：

```sh
node --version
npm start
```

无需执行 `npm install`。启动后打开 [中文工作台](http://127.0.0.1:3080)，在命令行按 `Ctrl+C` 停止服务。本地模式使用内置定时器，每分钟检查固定任务和提醒；电脑关机、休眠或服务停止时不会执行检查。

首次创建数据库时会写入演示任务和固定任务规则。示例只初始化一次，后续启动继续使用已有数据。如希望从空白数据库开始，在第一次启动前设置环境变量 `SEED_DEMO=0`。例如 PowerShell：

```powershell
$env:SEED_DEMO = '0'
npm start
```

直接运行 `npm start` 时，环境变量由当前终端提供，不会自动读取 `.env`。可选变量包括 `PORT`（默认 `3080`）、`DATA_DIR`（默认项目内的 `data`）和 `SEED_DEMO`（默认启用演示数据）。

### Windows 启动脚本

双击 [启动平台.cmd](启动平台.cmd) 可自动选择可用的 Docker 或本地 Node.js，启动后打开页面；使用结束时双击 [停止平台.cmd](停止平台.cmd)。脚本根据所在目录定位代码和数据，可在不同电脑上的任意项目目录使用。

明确选择本地模式：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Mode Local
```

脚本首次运行会自动生成本地 `.env`，其中包含随机调度与工作流密钥。脚本模式如需空白初始化，可先仅生成配置：

```powershell
. .\scripts\common.ps1
Initialize-Platform
```

然后把 `.env` 中的 `SEED_DEMO` 改为 `0`，再启动平台。这只影响数据库的首次初始化，不会清除已有任务。

### Docker 与定时工作流

在 Windows 安装并启动 Docker Desktop，执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Mode Docker
```

脚本准备密钥并启动应用与 n8n 定时工作流。业务页面仍为 `http://127.0.0.1:3080`，仅供维护的 n8n 编辑器为 `http://127.0.0.1:5680`。首次拉取镜像需要网络。

已有 `.env` 后，也可以使用 Docker Compose：

```sh
docker compose up -d --build --wait
docker compose logs --tail 100 application n8n
docker compose down
```

不要同时使用本地与 Docker 两种方式操作同一份数据库。修改代码后，Docker 模式需重新构建应用镜像才能生效。

## 完成任务与提交材料

任务的“提交形式”决定支持的文件：

| 提交形式 | 支持的扩展名 |
| --- | --- |
| 文本 | `.txt`、`.md`、`.doc`、`.docx`、`.rtf` |
| 表格 | `.csv`、`.xls`、`.xlsx` |
| 演示文稿 | `.ppt`、`.pptx` |
| PDF | `.pdf` |
| 图片 | `.png`、`.jpg`、`.jpeg`、`.webp` |
| 不限 | 以上全部格式 |

点击“标记完成”后，上传 1—5 个文件，单个不超过 10 MiB，总计不超过 25 MiB，并确认已按交付要求核对内容。系统校验格式、大小和基础文件结构，业务内容由提交人确认。重新打开任务后，再次完成需要上传本次材料；历史材料保留。

## 数据与备份

业务数据库和交付材料保存在 `data/office.sqlite`。可在平台设置下载完整业务备份，也可使用 [备份数据.cmd](备份数据.cmd)。`backups/` 存放本地备份，`data/n8n/` 存放工作流运行数据。

代码仓库不应包含 `.env`、`data/`、`backups/`、个人任务、上传文件或运行日志。下载或克隆代码会创建独立的本地数据，不会获得仓库维护者的业务数据。迁移自己的数据时应单独备份，停止服务后再恢复；请勿通过 Git 分享数据库或密钥。

## 开发与验证

```sh
npm test
```

当前有 21 项自动化测试，使用隔离数据库，覆盖任务流程、周期调度、提醒、导入、材料校验、备份、回收站以及 HTTP 接口。

| 目录或文件 | 用途 |
| --- | --- |
| `public/` | 中文页面、样式与交互 |
| `server.mjs` | HTTP 服务与接口路由 |
| `lib/` | SQLite 业务逻辑、文件校验和 CSV 处理 |
| `test/` | 自动化测试 |
| `scripts/` | 启动、停止、备份和工作流初始化 |
| `workflows/` | n8n 工作流配置 |
| `compose.yaml`、`Dockerfile` | 容器运行配置 |

欢迎通过分支和拉取请求协作，具体步骤见 [贡献说明](CONTRIBUTING.md)。项目尚未附开源许可证；公开查看、下载代码与取得再分发授权并不等同，其他使用方式请与仓库维护者确认。
