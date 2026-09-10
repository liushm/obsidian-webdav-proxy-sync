# WebDAV Proxy Sync

A desktop-only Obsidian plugin that synchronizes notes and attachments with a WebDAV server through HTTP, HTTPS, SOCKS5, or SOCKS5H proxies.

一个支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H 代理的 Obsidian 桌面端 WebDAV 同步插件。

> **Beta / 测试版：** Back up your vault before the first sync. 首次同步前请备份仓库。

## Features / 功能

- Bidirectional synchronization of notes and attachments / 双向同步笔记与附件
- HTTP, HTTPS, SOCKS5 and SOCKS5H proxy support / 支持多种代理协议
- Manual, startup and scheduled sync / 手动、启动和定时同步
- Progress indicator and persistent diagnostic log / 实时进度和持久化诊断日志
- Conflict copies when both sides change / 双端修改时保留冲突副本
- Configurable timeouts and exclusion patterns / 可配置超时与排除规则
- Safe default: deletions are not propagated / 默认不传播删除，降低误删风险

## Installation / 安装

### Community plugins

After the plugin is accepted into the Obsidian community directory, install it from **Settings → Community plugins → Browse**.

插件进入社区目录后，可通过 **设置 → 第三方插件 → 浏览** 安装。

### Manual installation / 手动安装

Create `.obsidian/plugins/webdav-proxy-sync/` in your vault and copy:

- `main.js`
- `manifest.json`
- `styles.css`

Restart Obsidian and enable **WebDAV Proxy Sync**.

### Build from source / 从源码构建

```bash
npm install
npm run build
```

## Configuration / 配置

Open **Settings → WebDAV Proxy Sync** and configure:

- WebDAV URL, for example `https://example.com/dav`
- Username and password
- Remote folder, for example `obsidian`
- Optional proxy, for example `socks5h://127.0.0.1:7890`
- Sync interval and exclusion patterns

For OpenList, use the actual WebDAV endpoint, which commonly ends in `/dav`, rather than the web interface URL.

## Synchronization behavior / 同步规则

- Local only → upload / 仅本地存在则上传
- Remote only → download / 仅远端存在则下载
- Local changed → upload / 仅本地变化则上传
- Remote changed → download / 仅远端变化则下载
- Both changed → preserve a local `*.conflict-local-*` copy, then download the remote version
- Deletions are not propagated in the current version. A file deleted on only one side is restored from the other side.

The plugin scans metadata on both sides during each run but transfers file content only when required.

## Privacy and security / 隐私与安全

- No telemetry or analytics / 不包含遥测或统计
- No developer-operated service is contacted / 不连接开发者运营的服务器
- Network requests are sent only to the user-configured WebDAV server and optional proxy
- Credentials are stored locally in the plugin's `data.json` file and are not encrypted by the operating-system keychain
- Diagnostic logs contain file paths and errors, but never intentionally include the configured password
- Disabling HTTPS certificate verification reduces connection security and should only be used with a trusted self-signed server

## Limitations / 当前限制

- Desktop only; proxy support relies on Node.js networking APIs
- Deletions are not synchronized
- Some WebDAV implementations do not support `Depth: infinity`
- Some OpenList storage drivers may delay or reject `MKCOL` directory creation
- First sync should be tested with a backup and a dedicated remote directory

## Reporting issues / 反馈问题

When reporting an issue, include:

- Obsidian version
- Plugin version
- WebDAV server type
- Proxy type, without credentials
- Relevant entries copied from the plugin sync log

Do not publish usernames, passwords, proxy credentials, tokens, or private note contents.

## License

MIT
