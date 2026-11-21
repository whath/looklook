# looklook

Windows 桌面行情看板。内置已筛选的 28 个分类、138 只 A 股标的。点击标题可编辑，默认是「记住来时路，坚定未来路」。所有分类标签换行排列，点击标签会滚动到对应的行情卡片。标签和卡片标题都显示分类内有效报价的等权平均日涨跌幅，缺失报价显示 `—`，并从平均值中排除。

## 连接服务器

首次打开应用，在「设置」中填写服务器的访问令牌，保存后立即获取行情。接口已预填为 `https://ericcself.top/v1/looklook/quotes`。标题、当前分类和连接设置保存在本机。访问令牌由现有后台授权，仓库和安装包均不含令牌。

桌面端启动后每 15 分钟请求一次阿里云应用接口。后端复用 GprojectBack 的 AKShare 行情链路。主源失败时，使用腾讯批量行情查询观察名单。后台每 15 分钟生成一次快照，接口读取缓存。采集或连接失败时可继续查看上次取得的行情，状态栏标明缓存或连接状态。`拉取` 显示采集时间，报价源提供交易日时也会显示交易日。后端实现与接口契约见 [GprojectBack 的 looklook 行情模块](https://github.com/whath/GprojectBack/tree/looklook/quotes)。

## Windows 开发和打包

构建需要 Node.js 22.12+、Rust、Visual Studio C++ Build Tools 和 WebView2 Runtime。

```powershell
npm ci
npm run tauri -- dev
npm run tauri -- build
```

安装包位于 `src-tauri/target/release/bundle/nsis/`。用本地 GprojectBack 联调时，可在连接设置输入 `http://127.0.0.1:8000`。
