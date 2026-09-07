# Yeaft 英文展示视频

基于 `ebd2745c35d526310a74344ef4a7d284a940282d` 的八页 `yeaft-work-anywhere.pdf` 制作。

## 交付

- `yeaft-work-anywhere-en.mp4`：4K（3840×2160）、30 fps、H.264 CRF 14 / AAC 192 kbps，英文合成配音与烧录字幕，约 110 秒。
- `yeaft-work-anywhere.en.srt`：独立英文字幕。
- `narration.en.txt`：英文配音稿。
- `timeline.json`：按实际音频长度生成的逐页时间轴。
- `video-preview.jpg`：从最终 MP4 抽取的八页预览。
- `verification.json`：完整解码、时长、音轨、字幕时间范围与 SHA-256 校验结果。

原稿的 Preview / staged demo / illustrative 标识保留。新版取消逐帧缩放，页面停留时完全静止；七次换页使用 0.6 秒交叉溶解，不把字幕带入转场。PDF 直接按最终画面内容宽度光栅化，减少文字重采样损失；内嵌截图仍受原图分辨率限制。视频不是真实软件操作录屏，也不代表开发任务已成功执行。

配音改为对话风格的 Microsoft Edge `en-US-AndrewNeural`，重写为短句讲稿，正常语速生成，不做后期时间拉伸。音量按 -18 LUFS 目标归一化。源 TTS 是 24 kHz 压缩语音，输出 AAC 192 kbps 只能减少再编码损失，不会让源音质凭空提高。未经过人工试听，不能保证主观自然度或品牌 Yeaft 的读音；不添加背景音乐。

文件采用质量优先编码，不填充数据凑到 30 MB。静止画面压缩率高，实际大小以校验报告为准。

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
