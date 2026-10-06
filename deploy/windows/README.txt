CasaTeCopy 本地版 使用说明
==========================

1. 双击「启动.bat」。
   - 第一次如果电脑没有 Node.js，会自动尝试安装，装好后再双击一次。
2. 浏览器会自动打开 http://localhost:3000 ，在网页里操作即可。
3. 使用期间不要关闭黑色窗口；关掉窗口就停止服务。
4. 已下载的商品图片、价格记录保存在本文件夹的 saved_images 里，更新程序时请保留它。
5. 查询 Carrefour 时程序会在后台启动一个独立的 Edge/Chrome（配置保存在 browser_profile 文件夹，
   不影响你平时用的浏览器），闲置 5 分钟后自动关闭。

更新程序：在项目里运行 npm run package:local，
把 release/CasaTeCopy 里的 server.mjs 和 dist 覆盖到这里即可。
