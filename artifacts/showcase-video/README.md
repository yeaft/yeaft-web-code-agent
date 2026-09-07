# Yeaft 英文展示视频

基于 `ebd2745c35d526310a74344ef4a7d284a940282d` 的八页 `yeaft-work-anywhere.pdf` 制作。

## 交付

- `yeaft-work-anywhere-en.mp4`：1080p、24 fps、H.264 / AAC，英文合成配音与烧录字幕，约 110 秒。
- `yeaft-work-anywhere.en.srt`：独立英文字幕。
- `narration.en.txt`：英文配音稿。
- `timeline.json`：按实际音频长度生成的逐页时间轴。
- `video-preview.jpg`：从最终 MP4 抽取的八页预览。
- `verification.json`：完整解码、时长、音轨、字幕时间范围与 SHA-256 校验结果。

原稿的 Preview / staged demo / illustrative 标识保留。视频是静态演示稿加轻微镜头推进、淡入淡出与字幕，不是真实软件操作录屏，也不代表开发任务已成功执行。使用 Microsoft Edge `en-US-GuyNeural` 合成英文配音，不添加背景音乐；未经过人工试听，品牌读音仍可按反馈调整。

## 重建

工具安装在隔离 Python 环境，不修改在线 Agent 或系统工具。语音生成会向 Microsoft Edge 在线语音服务发送本目录公开产品讲稿，需要联网。

```bash
python3 -m venv /tmp/yeaft-video-tools
/tmp/yeaft-video-tools/bin/python -m pip install imageio-ffmpeg==0.6.0 pymupdf==1.28.2 edge-tts==7.2.8 pillow==12.3.0
/tmp/yeaft-video-tools/bin/python artifacts/showcase-video/make-video.py prepare --pdf /path/to/yeaft-work-anywhere.pdf
/tmp/yeaft-video-tools/bin/python artifacts/showcase-video/make-video.py render
/tmp/yeaft-video-tools/bin/python artifacts/showcase-video/verify-video.py
```

英文字幕基于 TTS word boundaries 对齐，标点从讲稿恢复；每个字幕时间区间不重叠。中间音频、渲染画面和分段视频保存在被 Git 忽略的 `render/`。

## 验证边界

- 视频门禁：`verify-video.py` 实际解码整个 MP4，并从八个场景分别抽帧。
- 生成脚本：`python -m py_compile`。
- 仓库门禁：运行 `npm test`，结果以交付回复为准。
- 不修改 Agent / Server / Web 产品实现，不触发运行服务重启或版本发布。
