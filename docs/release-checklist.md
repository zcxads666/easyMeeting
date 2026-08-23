# Release Checklist

- [ ] 更新版本号和 changelog/release notes
- [ ] `npm ci`
- [ ] `npm test` 全部通过
- [ ] `npm run setup:python && npm run test:python` 全部通过
- [ ] `npm run build` 通过
- [ ] Linux xvfb Electron smoke 通过
- [ ] Windows、macOS、Linux electron-builder 产物成功
- [ ] `npm run verify:package` 通过
- [ ] 产物不含 `.venv`、models、data、settings、logs、credential
- [ ] Windows/macOS/Linux 安装包人工启动检查
- [ ] Cloud-only 模式在 Runtime 缺失时仍可启动
- [ ] Runtime install/repair、模型下载取消/重试和诊断导出人工检查
- [ ] 未提交本地会议、音频、模型或 secret
