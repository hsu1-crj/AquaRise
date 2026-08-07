# LLM模块工作记录 (2026-08-05)

## 系统定位
水下垃圾自动识别与海洋污染分析系统。LLM角色是"海洋守护者"聊天助手。

## 今日完成

### 1. 数字人 → 魔珐星云平台接入 ✅
- SDK: XmovAvatar, CDN引入
- `sdk_integration.js`: XmovAvatar API封装 (init/speak/idle/think/destroy)
- 测试通过，数字人可正常加载

### 2. 微调数据集 (ShareGPT格式)
- ocean_trash_qa: 169 / ocean_knowledge_qa: 69 / multi_turn: 14
- 合计252条，JSON验证通过

### 3. RAG知识库 (data/knowledge/)
- 降解周期表 / 垃圾分类 / MARPOL公约 / 微塑料 / 治理技术 共5篇

### 4. 后端服务 ✅
- `src/backend/main.py`: FastAPI (8000端口)，同源架构
- `/assistant` / `/api/v1/chat` / `/docs`
- LLM链: API→ChatService→Ollama→qwen2:0.5b
- `start.bat`: 双击启动+自动打开浏览器

### 5. 前端UI ✅
- `src/frontend/static/assistant.html`: 海洋深蓝主题
- **布局**: 左40%数字人+右60%对话，<850px上下布局
- **数字人区域**: 标题+3D模型(flex填充无裁切)+状态圆点+字幕框+波浪粒子背景
- **字幕组件**: 半透明深色圆角框，播报同步显示台词，3秒后淡出，思考中显示"正在生成回答"
- **状态系统**: 空闲(绿)/思考(黄闪烁)/播报(蓝闪烁)/离线(灰)
- **消息气泡**: AI左青蓝+头像，用户右深蓝，250ms入场动画
- **思考提示**: 对话流内"海洋守护者正在思考…"三点呼吸动画
- **快捷提问**: 3条海洋环保问题，hover上浮+阴影
- **纯文本模式**: 一键隐藏左侧全屏对话

### 6. 故障修复
- 数字人初始化→sdk路径+onMessage过滤+错误详情
- 页面问答智障→Ollama直连+后端同源
- 批处理乱码→纯英文
- 数字人裁切→flex填充
- 字幕缺失→cap组件+speak联动+淡出

### 7. 清理
- cache/gitkeep/pycache全部清除，无临时文件

## 交付物状态

| 编号 | 任务 | 状态 |
|------|------|------|
| L-01 | 语料收集 | ✅ |
| L-02 | 微调数据集 | 🟡 252/700 |
| L-04 | 基座选型 | ✅ qwen2:0.5b |
| L-08 | Ollama部署 | ✅ |
| L-09 | 对话API+后端 | ✅ |
| R-01~04 | RAG | ✅ |
| DH-01~13 | 数字人(魔珐星云) | ✅ |

## 启动
```
双击 start.bat → http://localhost:8000/assistant
```
前提: Ollama运行 + qwen2:0.5b拉取
