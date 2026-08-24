# Third-party runtime notices

标准离线桌面包会分发以下第三方运行时组件：

- Python 与 PyInstaller 生成的应用运行时；具体 Python 包版本由 `python/requirements.txt` 和构建产物 `runtime-manifest.json` 记录。
- FFmpeg 与 FFprobe 静态二进制，由 `ffmpeg-static` / `@derhuerst/ffprobe-static` 获取。安装包同时携带上游包提供的 `LICENSE` 文件；二进制来源记录在 <https://github.com/eugeneware/ffmpeg-static>。

发布者必须在对外分发前复核最终二进制的编译选项、许可证和对应源代码提供义务。本文件记录来源，不替代法律审查。
