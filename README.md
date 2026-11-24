# looklook

Windows 桌面行情看板。内置已筛选的 28 个分类、138 只 A 股标的。点击标题可编辑，默认是「记住来时路，坚定未来路」。分类标签和卡片都按有效报价的等权平均日涨跌幅从高到低排列，无有效报价的分类放在末尾。点击标签会滚动到对应的卡片行。箭头数字比较最近两轮不同快照的板块名次，`0` 表示持平，`—` 表示缺少可比较的排名。

个股涨幅右侧的 `↑+0.30` 或 `↓−0.30` 表示日涨幅较同一交易日上一轮快照上升或下降 0.30 个百分点。持平显示 `0.00`，缺少可比较的报价时显示 `—`。

## 连接服务器

首次打开应用，在「设置」中填写服务器的访问令牌，保存后立即获取行情。接口已预填为 `https://ericcself.top/v1/looklook/quotes`。标题、当前分类和连接设置保存在本机。访问令牌由现有后台授权，仓库和安装包均不含令牌。

后台与桌面端按北京时间交易日运行。上午 09:26 至 11:26、下午 13:01 至 14:46，各自每 15 分钟一轮。桌面端在每轮的第 30 秒请求阿里云缓存接口，为服务器采集留出时间。午休、盘后、周末和交易所休市日暂停请求。客户端使用已发布的交易日历，遇到未覆盖年份会暂停。 [上交所休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/)

后端复用 GprojectBack 的 AKShare 行情链路。主源失败时，使用腾讯批量行情查询观察名单。后台生成快照，接口读取缓存。桌面端保存最近一次成功快照，休市或连接失败时仍可查看。分类标题旁的「上次刷新」显示当前行情快照的服务器采集时间（北京时间）。报价源提供交易日时，状态栏也会显示交易日。后端实现与接口契约见 [GprojectBack 的 looklook 行情模块](https://github.com/whath/GprojectBack/tree/looklook/quotes)。

## Windows 开发和打包

构建需要 Node.js 22.12+、Rust、Visual Studio C++ Build Tools 和 WebView2 Runtime。

```powershell
npm ci
npm run tauri -- dev
npm run tauri -- build
```

安装包位于 `src-tauri/target/release/bundle/nsis/`。用本地 GprojectBack 联调时，可在连接设置输入 `http://127.0.0.1:8000`。
