# WebDAV Proxy Sync

一个支持代理的 Obsidian 桌面端 WebDAV 双向同步插件。

## 功能

- WebDAV 双向同步笔记和附件
- 支持 HTTP、HTTPS、SOCKS5、SOCKS5H 代理
- 手动同步、启动同步和定时同步
- 同步状态栏与连接测试
- 实时进度：当前文件、已检查数量和总数量
- 持久化同步日志：错误详情、失败文件和简化堆栈
- 可配置网络超时
- 修复 OpenList 在下载后刷新 ETag 导致的重复下载
- 首次遇到同名同大小文件时建立同步基线，不重复传输
- 双端同时修改时保留本地冲突副本
- 安全默认值：不传播删除、默认排除 `.obsidian` 与 `.trash`

## 安装

### 直接安装构建产物

1. 在仓库中创建目录：`.obsidian/plugins/webdav-proxy-sync/`
2. 将以下文件复制进去：
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. 重启 Obsidian。
4. 打开“设置 → 第三方插件”，启用 **WebDAV Proxy Sync**。

### 从源码构建

```bash
npm install
npm run build
```

## OpenList 配置示例

- WebDAV 地址：`https://example.com/dav`
- 远程目录：`obsidian`
- SOCKS 代理：`socks5h://127.0.0.1:7890`
- HTTP 代理：`http://127.0.0.1:7890`

WebDAV 地址必须是 DAV 入口，而不是 OpenList 网页首页。

## 同步规则

- 仅本地存在：上传。
- 仅远程存在：下载。
- 只有本地变化：上传。
- 只有远程变化：下载。
- 本地和远程同时变化：把本地版本保存为 `*.conflict-local-时间戳.*`，然后下载远程版本。
- 当前版本不传播删除，避免首次使用或配置错误造成文件丢失。

首次同步通过修改时间判断方向，之后使用本地签名和远程 ETag 判断变化。正式使用前建议备份仓库。

## 注意事项

- 插件依赖 Node.js 网络能力，因此仅支持 Obsidian 桌面版。
- 密码存放在插件目录的 `data.json` 中，没有经过系统钥匙串加密。
- 部分 WebDAV 服务不支持 `Depth: infinity`。这种服务需要改成递归的 `Depth: 1` 列目录实现。
- 如果使用 HTTPS WebDAV 和 HTTP 代理，代理会通过 CONNECT 隧道连接服务器。

## 开发状态

当前版本为可测试的 MVP。同步时会扫描并比较本地和远程文件元数据，但只上传或下载发生变化的文件内容。建议先用一个测试仓库和独立远程目录验证，再用于正式笔记库。
