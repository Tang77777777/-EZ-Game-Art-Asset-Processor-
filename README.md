# EZ 游戏美术素材加工器

**EZ 游戏美术素材加工器**是一款面向本地使用的游戏美术素材一次性加工工具。

它把图片序列、GIF、MP4 视频或 AI 生成结果，统一转换为经过抠图、剪裁、切分、整理和导出的游戏素材。整个流程围绕：

> **素材导入 → 抽帧/剪裁 → 抠图或处理 → 素材整理 → 精灵图或序列帧导出**

本项目不是传统的逐帧动画编辑器，不包含项目文件、时间轴和复杂动画工程保存功能。它更适合快速把外部素材加工成可以直接放入游戏项目的 PNG、精灵图和序列帧资源。

项目仓库：

[EZ Game Art Asset Processor GitHub 仓库](https://github.com/Tang77777777/-EZ-Game-Art-Asset-Processor-)

## 主要功能

### 1. 多来源素材导入

支持以下素材来源：

- PNG、JPG 等图片序列
- GIF 动图
- MP4 等本地视频
- AI 生成的图片或视频
- 外部 CLI 工具生成的素材
- OpenAI 兼容 API、百炼、Gemini、MiniMax 等服务生成的素材

图片可以批量选择、排序和删除；视频可以按帧率、间隔或指定时间点进行抽帧。

### 2. 视频抽帧

视频抽帧采用两级策略：

1. 优先使用浏览器解码和 Canvas 抽帧
2. 浏览器无法解码时，自动回退到服务端 FFmpeg

支持：

- 按 FPS 抽帧
- 每隔 N 个原始帧取一帧
- 指定开始时间和结束时间
- 指定多个时间点精确取帧
- 一次最多提取 64 帧
- 抽帧完成后继续执行抠图和导出

### 3. 图片剪裁

剪裁工具针对像素素材设计，支持：

- 整数像素框选
- X、Y、宽度、高度数字调整
- 滚轮缩放
- 像素网格
- 自动检测透明边界
- 自动裁掉图片四周空白
- 剪裁结果直接输出为 PNG

### 4. 多种背景处理方式

处理阶段支持三种模式：

- **纯色移除**：适合绿幕、白底或其他单色背景
- **AI 抠图**：使用 rembg 和指定模型自动生成透明背景
- **跳过处理**：保留原始背景，在导出时继续使用

当前代码中的抠图引擎解析顺序是：

```text
设置页自定义 CLI
→ 项目内置 rembg
→ 系统 PATH 中的 rembg
→ 原图复制并给出警告
```

因此，目前这台电脑并不是同时安装了多个抠图引擎。实际使用的是：

```text
rembg 2.0.81
onnxruntime 1.29.0
Pillow 12.3.0
默认模型：u2net
```

其中：

- `rembg` 是真正的抠图工具
- `onnxruntime` 是 rembg 使用的推理后端
- `u2net` 是抠图模型，不是单独的引擎
- `Pillow` 是 Python 图像处理依赖

当前模型缓存目录为：

```text
storage/models/models/u2net
```

### 5. 网格切分和连通域切分

支持将一张精灵图拆分成多个独立素材：

- 按行列均匀网格切分
- 自动检测不透明连通区域
- 自动避免把一个部件从中间切开
- 每个切分结果可以自动裁透明边
- 原始图片保留，不会被破坏

### 6. 素材库

素材库是本项目唯一的长期存储区域，支持：

- 多级文件夹
- 来源类型标识
- 图片和视频素材
- 批量选择
- Cmd/Ctrl 多选
- Shift 范围选择
- 拖拽移动到文件夹
- 批量抠图
- 批量删除
- 素材重命名
- 原图与抠图结果对比
- 素材右键快捷操作

### 7. 视频素材编辑

视频素材可以在素材库中继续处理：

- 像素风视频播放器
- 拖动进度条取帧
- 按时间区间和 FPS 批量抽帧
- 精确时间点抽帧
- 抽帧后自动写入素材库
- 可继续执行抠图、剪裁和导出

### 8. AI 生成

AI 生成面板支持：

- 图片生成
- 视频生成
- 多张图片批量生成
- 引用素材图
- 多引用图排序
- 提示词加强
- 图片和视频分别选择模型
- 图片和视频分别设置尺寸
- 生成完成后自动写入素材库
- 生成图片后继续抠图和导出
- 生成视频后继续抽帧

项目支持配置多个 Provider 共存，包括：

- CLI
- OpenAI 兼容 API
- 阿里云百炼 DashScope
- Gemini / Nano Banana
- MiniMax

这些 AI 服务不是项目内置服务，需要用户自行准备 API Key 和模型权限。

### 9. 场景分层

场景分层可以调用独立配置的图像分层服务，将一张扁平图拆分为：

- 背景
- 主体
- 道具
- 地面
- 前景
- 其他语义图层

分层结果会以新的 RGBA 素材保存到素材库。

需要注意：场景分层是语义分层，不是严格的人体部位分割。它不能保证把人物拆成头、躯干、手臂和腿。

### 10. 素材编辑

图片素材可以进行：

- 橡皮擦
- 旋转
- 镜像
- 纯色移除
- 自动裁透明边
- 重新剪裁
- 恢复原图
- 查看处理前后对比

### 11. 精灵图和序列帧导出

支持两种导出方式：

- 单张精灵图 PNG
- 每帧独立 PNG 的 ZIP 序列

精灵图导出参数包括：

- 单帧宽度
- 单帧高度
- 行数
- 列数
- 帧间距
- 最大图集尺寸
- FPS
- 文件名前缀

导出时会同时生成帧元数据 JSON，记录帧顺序、尺寸、位置和动画信息。

## 外部工具和相关链接

| 组件 | 用途 | 是否必须 |
|---|---|---|
| [Bun](https://bun.sh/docs/installation) | JavaScript 运行时、依赖管理和服务启动 | 必须 |
| [FFmpeg](https://ffmpeg.org/download.html) | GIF/MP4 抽帧和部分缩略图回退处理 | 视频/GIF 必须 |
| [rembg](https://github.com/danielgatis/rembg) | 本地 AI 抠图引擎 | AI 抠图需要 |
| [ONNX Runtime](https://onnxruntime.ai/docs/install/) | rembg 的模型推理后端 | 随 rembg 安装 |
| [U²-Net](https://github.com/xuebinqin/U-2-Net) | 默认 `u2net` 抠图模型来源 | 首次抠图自动下载 |
| [uv](https://docs.astral.sh/uv/) | Python 环境和依赖管理工具 | 安装 rembg 时推荐 |
| [Python](https://www.python.org/downloads/) | rembg 的运行环境 | 安装 rembg 时需要 |
| [Model Context Protocol](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro) | 让 AI 助手调用本项目功能 | 可选 |

Bun 官方文档提供 macOS、Linux、Windows 安装方式；FFmpeg 官方页面提供不同平台的下载入口；rembg 官方项目同时提供 CLI、Python 库、HTTP 服务和 Docker 使用方式；ONNX Runtime 官方文档则区分 CPU、CUDA、DirectML 等运行后端。([bun.sh](https://bun.sh/docs/installation?utm_source=openai))

## AI 服务链接

| 服务 | 适用功能 | 官方资料 |
|---|---|---|
| OpenAI | 图片生成、图片编辑、提示词加强 | [Image Generation API](https://platform.openai.com/docs/guides/image-generation) |
| 阿里云百炼 | 万相、千问图像生成和编辑、视频生成 | [万相图像生成 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) |
| Gemini / Nano Banana | 图片生成、图片编辑、多图参考 | [Gemini Image Generation](https://ai.google.dev/gemini-api/docs/image-generation) |
| MiniMax | 文生视频、图生视频、首尾帧视频 | [MiniMax Video Generation](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create) |

## 安装和启动

### macOS / Linux

```bash
git clone https://github.com/Tang77777777/-EZ-Game-Art-Asset-Processor-.git EZGameArtAssetProcessor
cd EZGameArtAssetProcessor

bun install
```

如果需要处理 GIF 或 MP4建议使用：

```bash
brew install ffmpeg
```

如果需要 AI 抠图建议安装：

```bash
./scripts/setup_matting.sh
```

启动项目：

```bash
bun dev
```

浏览器打开：

```text
http://localhost:3000
```

### Windows

```powershell
winget install ffmpeg
winget install --id=astral-sh.uv -e
```

安装抠图环境：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1
```

启动：

```powershell
bun install
bun dev
```

项目的抠图安装脚本会优先寻找 Python 3.11–3.13；如果系统没有合适版本，则可以通过 uv 创建隔离的 Python 3.12 环境。

## 推荐使用流程

### 图片序列

```text
打开首页
→ 选择图片序列
→ 排序或删除图片
→ 可选剪裁
→ 选择纯色移除、AI 抠图或跳过
→ 调整精灵图参数
→ 导出精灵图或序列帧
```

### 本地视频

```text
打开首页
→ 选择本地视频
→ 设置 FPS、区间或时间点
→ 浏览器抽帧
→ 必要时自动回退 FFmpeg
→ 选择背景处理方式
→ 导出 PNG 序列或精灵图
```

### AI 生成图片

```text
设置页配置 AI Provider
→ 回到首页选择 AI 生成
→ 输入提示词
→ 可选引用素材图
→ 生成图片
→ 选择生成结果
→ 抠图或剪裁
→ 导出
```

### AI 生成视频

```text
设置页配置支持视频的 Provider
→ 输入动作描述
→ 生成视频
→ 在素材库打开视频
→ 使用 VIDEO CUT LAB 抽帧
→ 对帧进行抠图或剪裁
→ 导出精灵图或序列帧
```

### 素材库二次加工

```text
上传或生成素材
→ 进入素材库
→ 打开素材详情
→ 选择剪裁、切分、抠图、图层拆分或多动作生成
→ 确认结果
→ 导出或继续整理
```

## 设置页可以配置什么

设置页主要包括：

- 生成 Provider
- 图片模型
- 视频模型
- 文本模型
- 图片默认尺寸
- 视频默认尺寸
- 提示词加强模型
- 自定义 CLI
- 自定义抠图 CLI
- rembg 模型名
- 任务队列并发数
- 图片分层服务
- 主题模式
- 界面语言
- 系统体检与连接测试

项目内置的 MCP 服务端还可以让 Claude、Cursor、Windsurf 等 AI 工具通过协议直接操作素材、生成、抠图、文件夹和任务。MCP 本身是连接 AI 应用与外部工具、数据源和工作流的开放标准。([modelcontextprotocol.io](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro?utm_source=openai))

## 重要注意事项

- 项目默认只面向本机使用，没有用户登录和权限系统。
- 不建议把服务端口暴露到公网。
- 流水线中的中间产物主要保存在浏览器内存中，刷新页面会丢失当前流水线进度。
- 需要长期保留的素材应及时保存或导入素材库。
- 任务队列目前保存在内存中，服务重启后未完成任务会中断。
- rembg 第一次使用某个模型时会自动下载模型文件，可能需要等待较长时间。
- GIF 抽帧目前不保留原始帧延迟，而是按照统一帧率处理。
- 没有安装 FFmpeg 时，PNG 图片仍然可以正常导入、抠图和导出，但 GIF/MP4 抽帧不可用。
- 没有安装抠图引擎时，项目会原样复制图片并提示用户安装，不会让整个素材处理流程崩溃。
