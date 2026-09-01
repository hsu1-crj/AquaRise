# CLAUDE.md

本文件用于指导 Claude Code（claude.ai/code）在本仓库中进行开发与文档维护。

## 项目概述

**项目名称**: 水下垃圾自动识别与海洋污染分析系统
**团队编号**: 第8组
**实训周期**: 8周（320学时）
**Git仓库**: 猿舟 GitLab (`origin`) + GitHub 镜像 (`github`)
**主分支**: `master`

## 使用口径

- 本文件描述目标架构与开发约定，不代表对应模块已经实现。当前仓库仍处于规划阶段：`src/` 仅有占位文件，`README.md` 仍为 GitLab 默认模板。
- 执行命令或引用路径前必须先确认对应文件真实存在；不得把规划中的目录、接口或测试结果表述为已完成。
- 信息冲突时，以仓库实际内容和已评审的需求/设计文档为准，并同步修正文档。`项目规划文档.md` 用于范围与排期；Git 协作规范（待创建 `规范提交代码与开发流程.md`）以本文件"常用命令→Git协作"章节为准。
- Token、密码、私钥和平台 `appSecret` 只能通过服务端环境变量或密钥管理注入，不得写入仓库、浏览器代码、页面配置或日志。

## 目标仓库结构（规划）

```
issedu_ysu2026_7439/
├── README.md                          # 项目入口说明（当前为GitLab默认模板，待更新）
├── 成员同步仓库配置指南.md              # 团队Git配置说明
├── 规范提交代码与开发流程.md            # Git提交规范与协作流程
├── CLAUDE.md                          # 本文件 — AI开发指导
├── 项目规划文档.md                     # 详细项目规划
├── src/                               # 规划中的源代码目录（当前仅含占位文件）
│   ├── vision/                        # 计算机视觉模块
│   │   ├── train.py                   # YOLO模型训练
│   │   ├── detect.py                  # 目标检测推理
│   │   ├── video_process.py           # 视频逐帧处理
│   │   └── preprocess.py              # 水下图像预处理
│   ├── llm/                           # 大语言模型模块
│   │   ├── fine_tune/                 # LLaMA Factory微调配置
│   │   ├── deploy/                    # Ollama部署配置(Modelfile)
│   │   ├── chat_api.py                # LLM对话API
│   │   ├── rag/                       # RAG知识库模块
│   │   └── digital_human/             # 数字人交互模块
│   │       ├── sdk_integration.js      # 数字人API平台JS SDK集成(init/speak/状态控制)
│   │       ├── pipeline.py             # LLM→SDK文本驱动对接(断句+SSML注入)
│   │       └── config.yaml             # SDK配置(appId/avatarId/voiceId等)
│   ├── backend/                       # 后端服务（FastAPI 单服务）
│   │   ├── main.py                    # FastAPI主应用（ASGI入口）
│   │   ├── config.py                  # 配置管理
│   │   ├── models/                    # SQLAlchemy数据模型
│   │   ├── api/                       # API路由（/api/v1/*）与页面路由
│   │   ├── services/                  # 业务逻辑层
│   │   └── templates/                 # Jinja2模板（管理页面SSR）
│   └── frontend/                      # 前端静态资源
│       ├── static/css/                # 样式文件
│       ├── static/js/                 # JS脚本（ECharts配置等）
│       └── static/img/                # 图片资源
├── dataset/                           # 数据集（不纳入Git，独立存放）
│   ├── dataset/                        # TrashCan 1.0 原始数据
│   │   ├── instance_version/           # COCO格式-实例版本（22类）
│   │   ├── material_version/           # COCO格式-材质版本（16类）
│   │   ├── original_data/              # Supervisely原始标注
│   │   └── scripts/                    # 原始转换脚本
│   ├── yolo_dataset/                   # YOLO格式数据集（已完成转换）
│   │   ├── data.yaml                   # YOLO训练配置（22类）
│   │   ├── class_reference.md          # 类别参考文档
│   │   ├── images/train/               # 训练集 5,048张
│   │   ├── images/val/                 # 验证集 1,442张
│   │   ├── images/test/                # 测试集 722张
│   │   ├── labels/train/               # YOLO标注（训练集）
│   │   ├── labels/val/                 # YOLO标注（验证集）
│   │   └── labels/test/                # YOLO标注（测试集）
│   ├── convert_coco_to_yolo.py         # COCO->YOLO转换脚本（可复用）
│   └── 数据集处理进度报告.md            # 数据处理进度报告
├── data/                              # 其他数据（Git忽略大文件）
│   └── knowledge/                     # RAG知识库文档
├── models/                            # 模型权重（Git忽略）
│   ├── yolo/                          # YOLO训练权重
│   └── llm/                           # 微调后LLM（GGUF格式）
├── tests/                             # 测试用例
│   ├── test_vision.py
│   ├── test_api.py
│   └── test_llm.py
└── doc/                               # 项目文档（按实训规范组织）
    ├── 01.需求说明书/                  # 需求规格说明书
    ├── 02.设计说明书/                  # 详细设计文档（含ER图、架构图）
    ├── 03.测试用例/                    # 测试用例清单
    ├── 04.检视意见/                    # 代码检视记录
    ├── 05.问题列表/                    # Bug跟踪表
    ├── 06.用户手册/                    # 用户操作手册
    ├── 07.会议记录/                    # 每周会议纪要
    ├── 08.参考资料/                    # 参考论文、API文档链接
    ├── 09.文档模板/                    # 实训提供的10个模板文件
    ├── 10.计划书/                      # 迭代开发计划
    ├── 11.过程参考/                    # 过程参考文档
    └── 12.自检结果/                    # 自检结果记录
```

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 深度学习框架 | PyTorch | 模型训练底层框架 |
| 视觉模型 | YOLO11/YOLOv12, OpenCV | 垃圾目标检测 + 图像/视频处理 |
| 后端框架 | FastAPI | 单一服务（端口8000），生产环境承载 React 构建产物与 `/api/v1/*` REST/SSE接口 |
| 数据库 | MySQL (结构化) + ChromaDB (向量) | 检测记录 + RAG知识库 |
| 前端 | React 18 + TypeScript + Vite 6 + ECharts 5 + Marked + DOMPurify | 桌面端管理SPA + 数据可视化大屏 + 安全的流式Markdown展示 |
| LLM微调 | LLaMA Factory + LoRA/PEFT | 海洋领域大模型微调 |
| LLM部署 | Ollama (本地) | 模型私有化部署 |
| LLM应用 | LangChain + RAG | 检索增强生成 |
| 数字人交互 | 数字人API平台（具身智能3D数字人平台） | JS SDK浏览器端接入；具体能力、形象库与计费以平台正式文档和控制台为准 |
| 云GPU | AutoDL / 阿里云PAI | 模型训练加速 |
| 版本控制 | Git (猿舟 GitLab + GitHub镜像) | 代码管理 |

## 用户分组与后台管理（RBAC）

**模型**：功能模块（= 前端导航页面）→ 用户组（模块集合）→ 用户（归组获得功能）。三张表：`user_groups`（内置组 `is_system=True`）、`group_modules`（组-模块关联）、`users.group_id`（软外键）。

- 模块注册表：`src/backend/models.py` 的 `MODULE_REGISTRY`（11 个模块：dashboard / **ocean3d_monitor** / **ocean3d_science** / detection / history / analysis / screen / reports / assistant / atlas / admin），前端导航与后端守卫共用该口径。
- **3D 模式按组锁定**：海洋 3D 页拆两个权限键——`ocean3d_monitor`（监测模式）/ `ocean3d_science`（科普模式），页面入口 = 拥有任一模式键；超管双模式，监测分析组/指挥决策组锁监测模式，科普访客组锁科普模式（前端 `Ocean3D.tsx` 隐藏无权模式的切换按钮并自动纠偏当前模式）。旧库 `ocean3d` 单键由 `main._migrate_ocean3d_module_keys()` 自动迁移。
- 内置组：超级管理员（全模块+后台，权限不可改）、监测分析组（识别检测主线，3D 锁监测）、指挥决策组（研判大屏，3D 锁监测）、科普访客组（3D 科普+生命图谱，自助注册默认组，`config.DEFAULT_GROUP_CODE` 可改）。
- 权限计算：`src/backend/auth.py` `get_user_modules()`（role=admin 恒全量；其余按组实时查库，改组即时生效，无需重签 JWT）；接口守卫 `require_permission("module")`；全局数据视野 `is_privileged()`。
- 后台管理 API：`src/backend/routers/admin_router.py`（`/api/v1/admin/*`，概览/用户/用户组 CRUD）。前端：`src/frontend/src/pages/Admin.tsx`（概览/用户管理/用户组管理三个标签）。
- **注销规则（产品要求：只有最高管理员不能销号，其他均可销号）**：最高管理员（role=admin 或 super_admin 组成员）不可被注销、不可调组、密码仅本人修改；其余账号（含操作者自己）均可注销，前端注销自己后清登录态回登录页。超级管理员组不可改不可删；内置组不可删；有成员的组不可删。
- 启动播种：`src/backend/main.py` `_ensure_user_groups()` + `_migrate_ocean3d_module_keys()` + `_migrate_users_into_groups()`（存量 admin→超管组，其余历史用户→监测分析组，幂等）。

## 数据集信息

**TrashCan 1.0 Instance Version** — 已转换为YOLO格式，可直接用于训练。数据处理细节见 `dataset/数据集处理进度报告.md`。

| 属性 | 值 |
|------|-----|
| 总图片 | 7,212张 |
| 总标注框 | 12,128个 |
| 类别 | 22类（14垃圾目标 + 8背景类） |
| 划分 | Train 70% (5,048) / Val 20% (1,442) / Test 10% (722) |
| 配置文件 | `dataset/yolo_dataset/data.yaml` |
| 类别参考 | `dataset/yolo_dataset/class_reference.md` |
| 进度报告 | `dataset/数据集处理进度报告.md` |
| 转换脚本 | `dataset/convert_coco_to_yolo.py` |

**14个垃圾目标类**: trash_clothing(衣物), trash_pipe(管道), trash_bottle(瓶子), trash_bag(塑料袋), trash_snack_wrapper(零食包装), trash_can(金属罐), trash_cup(杯子), trash_container(容器), trash_unknown_instance(未知垃圾), trash_branch(树枝/木头), trash_wreckage(残骸/碎片), trash_tarp(防水布), trash_rope(绳索), trash_net(渔网)

**8个背景类（水下生物/设备）**: rov, plant, animal_fish, animal_starfish, animal_shells, animal_crab, animal_eel, animal_etc

> **已知局限**: trash_unknown_instance 占比最高(~45.9%)；trash_cup(59框)、trash_clothing(82框)、trash_snack_wrapper(84框) 样本极少。训练时需使用类别加权损失函数。详见 `dataset/yolo_dataset/class_reference.md` 和 `dataset/数据集处理进度报告.md`。

## 常用命令

> 下列命令是目标用法。运行前先确认依赖、配置和对应脚本已经落地；规划阶段不应假定命令可直接执行。

### Git协作（遵循 规范提交代码与开发流程.md）

```bash
# 开发前拉取最新代码
git pull --ff-only origin master

# 创建功能分支
git switch -c feature/功能名称    # 新功能
git switch -c fix/问题名称        # 缺陷修复
git switch -c docs/文档名称       # 文档修改

# 提交（格式：<type>: <简短说明>）
git add <具体文件>
git commit -m "feat: 增加XXX功能"
git commit -m "fix: 修复XXX问题"
git commit -m "docs: 更新XXX文档"

# 推送当前功能分支并创建MR
git push -u origin feature/功能名称
# 仅在项目负责人明确允许直接提交主分支时使用
git push origin master

# 常用检查
git status
git diff --check
git log --oneline --decorate --graph -10
```

### 环境管理

```bash
# 创建conda虚拟环境
conda create -n underwater python=3.10
conda activate underwater

# 安装依赖
pip install -r requirements.txt
```

### 视觉模型训练

```bash
# YOLO目标检测训练（也可直接使用 ultralytics CLI）
python src/vision/train.py --model yolo11 --epochs 100 --batch 16 --data dataset/yolo_dataset/data.yaml
# 或: yolo detect train data=dataset/yolo_dataset/data.yaml model=yolo11n.pt epochs=100 batch=16 imgsz=640

# 视频逐帧检测
python src/vision/video_process.py --input data/raw/video.mp4 --output results/

# 单张图片检测
python src/vision/detect.py --image test.jpg --model models/yolo/best.pt
```

### 后端服务

```bash
# 启动 FastAPI 服务（管理页面 + API 接口，端口8000）
uvicorn src.backend.main:app --reload --port 8000

# 启动前端开发服务器（另开终端，端口5173，/api代理到8000）
cd src/frontend
npm install
npm run dev

# 访问入口
# 前端开发页面: http://localhost:5173
# API文档:      http://localhost:8000/docs
```

### LLM相关

```bash
# 启动Ollama服务
ollama serve

# 创建并运行微调后模型
ollama create ocean-assistant -f models/llm/Modelfile
ollama run ocean-assistant

# LLaMA Factory Web UI微调
llamafactory-cli webui

# 数字人API平台JS SDK - 嵌入海洋小助手页面
# 按平台正式SDK文档接入；浏览器端仅获取后端签发的短期鉴权凭证。
# appSecret仅存放于服务端环境变量，不得进入前端代码或仓库配置。
```

### 测试

```bash
# 运行所有测试
pytest tests/ -v

# 运行单个模块
pytest tests/test_vision.py -v
pytest tests/test_api.py -v
pytest tests/test_llm.py -v
```

## 开发约定

### 代码规范
- Python代码遵循PEP 8规范
- 模型训练参数通过YAML配置文件管理，禁止硬编码
- 所有文件/目录路径通过 `config.py` 统一管理
- API接口使用FastAPI自动生成Swagger文档（访问 `http://localhost:8000/docs`）
- 每个功能模块需有对应的单元测试（放在 `tests/` 目录）

### 前端开发约定
- 前端采用 **React 18 + TypeScript SPA**，由 Vite 6 提供开发构建链；源码放在 `src/frontend/src/`，生产构建产物输出到 `src/frontend/dist/` 并由 FastAPI 同源托管。现阶段只验收桌面网页版，不以移动端适配为交付目标。
- React、Vite、ECharts、Marked、DOMPurify等依赖通过 `src/frontend/package.json` 固定主版本并由npm管理；生产构建不得依赖公共CDN，答辩环境应预先执行 `npm install` 和 `npm run build`。
- 页面外壳、导航、图表与业务页面按 React 组件复用；路由采用Hash导航以兼容静态托管刷新。禁止复制公共逻辑或堆叠内联脚本。
- API地址、请求头、超时和错误解析由 `src/frontend/src/services/api.ts` 统一管理。开发环境通过Vite代理访问同源相对路径 `/api/v1/...`，生产环境由FastAPI同源提供。后端未完成期间使用与正式契约同结构的显式Mock模式；所有异步区域必须提供加载、空数据、失败和重试状态，页面不得静默失败。
- `POST /api/v1/chat` 的流式响应使用 `fetch` + `ReadableStream` 消费；`EventSource` 仅支持GET，禁止用于该POST接口。**切页卸载不中断在途对话流**：流由模块级在途状态（`InflightChat`）持有，`chunk` 回调在后台继续累积内容并通知订阅者；重挂载页面不阻塞等待，先渲染历史+已生成增量再订阅直播更新，结束后重拉历史落库答案。手动停止或重新提问时才用 `AbortController` 终止旧请求。
- LLM返回的Markdown先由 Marked 解析，再经 DOMPurify 清洗后写入DOM；禁止将用户输入、模型输出或接口错误直接赋给 `innerHTML`。前端文件类型/大小校验仅用于交互提示，服务端校验仍为最终依据。
- ECharts实例按容器复用并在销毁时 `dispose()`；通过 `ResizeObserver` 或窗口 `resize` 触发自适应。30秒刷新定时器在页面隐藏时暂停、离开页面时清理，禁止每次刷新重新初始化图表。
- Canvas检测框按原始媒体尺寸保存坐标，并根据实际渲染尺寸及 `devicePixelRatio` 换算，避免缩放后标注偏移。
- 交互控件应支持键盘操作并具备可见焦点；表单控件必须关联标签。页面至少验证 Chrome/Edge 最新稳定版，以及 1366×768、1920×1080 两档分辨率。

> 前端页面清单、路由规划和验收基线详见 `项目规划文档.md` 第六章（6.5.2节）和第十一章。前端开发任务分解与工时估算见 `项目规划文档.md` 第八章（8.4节）。

### Git提交规范
- **提交格式**: `<type>: <简短说明>`（详见 `规范提交代码与开发流程.md`）
- **常用type**: `feat`(新功能) `fix`(修复) `docs`(文档) `refactor`(重构) `test`(测试) `chore`(配置)
- 提交前必须执行 `git status` + `git diff --check` 检查
- 不提交 Token、密码、私钥、临时文件、构建产物
- 不使用 `git push --force` 覆盖团队分支
- Merge Request (MR) 审查通过后再合并到 master

### 文档规范
- 需求/设计文档使用 `doc/09.文档模板/` 中的对应模板
- 会议记录放入 `doc/07.会议记录/`，命名格式：`第8组会议记录_X.X.docx`
- Story列表使用 `doc/09.文档模板/Story列表_模板-v1.2.xltx`

## 团队分工

> 团队共5人；项目经理/组长由其中一名成员兼任（多见于后端或LLM工程师兼任，最终由团队协商确定）。详细分工与工时估算见 `项目规划文档.md` 第八章。

| 角色 | 职责范围 | 主要产出 |
|------|----------|----------|
| **视觉模型工程师** | YOLO训练/调优、视频处理、图像增强 | 训练后的模型权重、视频处理模块、模型评估报告 |
| **LLM工程师** | LLM微调/部署、RAG知识库、对话API、**数字人交互（数字人API平台接入与SDK集成，LLM→数字人文本驱动对接）** | 微调模型、RAG模块、Ollama部署配置、数字人SDK集成与LLM驱动对接 |
| **后端工程师** | FastAPI（管理页面SSR + API接口）、MySQL数据库、JWT认证 | 后端服务、数据库、API文档 |
| **前端工程师** | Jinja2页面与公共组件、ECharts大屏、流式聊天界面、响应式与交互状态 | 全部前端页面、可复用组件、前端联调记录与页面截图 |
| **测试工程师** | 测试用例、模型验证、系统集成测试、文档统筹 | 测试报告、Bug跟踪表、用户手册 |

## 文档对应关系

| 实训交付要求 | 仓库目录 | 使用模板 |
|-------------|---------|----------|
| 需求分析 | `doc/01.需求说明书/` | 需求规格说明书_模板-v2.0.dotm |
| 详细设计 | `doc/02.设计说明书/` | 设计说明书_模板-v1.3.dotm |
| 测试用例 | `doc/03.测试用例/` | 测试用例_模板 - V1.2.xltx |
| 测试报告 | `doc/03.测试用例/` | 测试报告_模板-v1.2.dotm |
| 问题列表 | `doc/05.问题列表/` | 问题列表_模板-v1.1.xltx |
| 会议记录 | `doc/07.会议记录/` | 会议记录（简）_v1.1.dotx |
| 迭代计划 | `doc/10.计划书/` | 迭代开发计划_模板-v1.1.xltx |
| 代码检视 | `doc/04.检视意见/` | 代码检视记录_模板-V1.0.xltx |
| 风险跟踪 | `doc/10.计划书/` | 风险跟踪表_模板-v1.1.xltx |

## 参考文档

- 详细项目规划（需求、分工、排期、API概要、考核标准）: `项目规划文档.md`
- Git协作规范（待创建）: `规范提交代码与开发流程.md`
- 仓库配置指南（待创建）: `成员同步仓库配置指南.md`
- 数据集处理进度: `dataset/数据集处理进度报告.md`
- 类别参考: `dataset/yolo_dataset/class_reference.md`
