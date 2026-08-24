# Release Checklist

- [ ] 更新版本号和 changelog/release notes
- [ ] `npm ci`
- [ ] `npm test` 全部通过
- [ ] `npm run setup:python && npm run test:python` 全部通过
- [ ] `npm run build` 通过
- [ ] Linux xvfb Electron smoke 通过
- [ ] Windows、macOS、Linux electron-builder 产物成功且 packaged startup smoke 通过
- [ ] 干净机器未安装 Python/FFmpeg 且断网时，内置 Runtime health 与 FFmpeg/FFprobe 检查通过
- [ ] `runtime-manifest.json` 的 platform/arch 与安装包一致，包内不含模型权重
- [ ] tag 发布的 Windows 产物已签名，macOS 产物已签名并公证
- [ ] 检查启动日志的 app-ready、splash-visible、server-listening、renderer-finished-load 阶段耗时
- [ ] `npm run verify:package` 通过
- [ ] 产物不含 `.venv`、models、data、settings、logs、credential
- [ ] Windows/macOS/Linux 安装包人工启动检查
- [ ] Cloud-only 模式在 Runtime 缺失时仍可启动
- [ ] Runtime install/repair、模型下载取消/重试和诊断导出人工检查
- [ ] Meeting v1/v2 → v3 与 settings v1/v2/v3 → v4 migration fixtures 通过
- [ ] Forced Alignment CPU 实机验证
- [ ] Forced Alignment CUDA 实机验证
- [ ] Diarization CPU 实机验证
- [ ] Diarization CUDA 实机验证
- [ ] Chunked realtime 录音、stop finalize 和后处理验证
- [ ] vLLM true streaming（Linux + CUDA）实机验证
- [ ] Qwen CPU / CUDA / MPS 分别实机验证
- [ ] 未提交本地会议、音频、模型或 secret

未实际验证的平台或硬件必须保持 unchecked，不能用 mock/CI 结果替代实机勾选。
