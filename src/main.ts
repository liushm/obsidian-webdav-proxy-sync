import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

interface SyncEntry {
  localSig: string;
  remoteSig: string;
}

interface PluginData {
  serverUrl: string;
  username: string;
  password: string;
  remoteFolder: string;
  proxyUrl: string;
  rejectUnauthorized: boolean;
  syncIntervalMinutes: number;
  syncOnStartup: boolean;
  excludes: string;
  syncState: Record<string, SyncEntry>;
}

interface DavItem {
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
  etag: string;
}

interface DavResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_DATA: PluginData = {
  serverUrl: "",
  username: "",
  password: "",
  remoteFolder: "obsidian",
  proxyUrl: "",
  rejectUnauthorized: true,
  syncIntervalMinutes: 10,
  syncOnStartup: false,
  excludes: ".obsidian/**\n.trash/**\n**/.DS_Store\n**/Thumbs.db",
  syncState: {},
};

class WebDavClient {
  private readonly baseUrl: URL;
  private readonly remoteRoot: string;

  constructor(private readonly settings: PluginData) {
    if (!settings.serverUrl.trim()) throw new Error("请先填写 WebDAV 地址");
    this.baseUrl = new URL(settings.serverUrl.trim().replace(/\/+$/, "") + "/");
    this.remoteRoot = cleanPath(settings.remoteFolder);
  }

  async test(): Promise<void> {
    await this.ensureRoot();
    await this.propfind("", "0");
  }

  async ensureRoot(): Promise<void> {
    if (!this.remoteRoot) return;
    await this.ensureDirectory(this.remoteRoot, true);
  }

  async list(): Promise<Map<string, DavItem>> {
    await this.ensureRoot();
    const response = await this.propfind("", "infinity");
    return this.parsePropfind(response.body.toString("utf8"));
  }

  async stat(path: string): Promise<DavItem | null> {
    try {
      const response = await this.propfind(path, "0");
      return this.parsePropfind(response.body.toString("utf8")).get(cleanPath(path)) ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) return null;
      throw error;
    }
  }

  async download(path: string): Promise<ArrayBuffer> {
    const response = await this.request("GET", path);
    return response.body.buffer.slice(
      response.body.byteOffset,
      response.body.byteOffset + response.body.byteLength,
    ) as ArrayBuffer;
  }

  async upload(path: string, data: ArrayBuffer): Promise<DavItem> {
    const normalized = cleanPath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDirectory(parent);
    await this.request("PUT", normalized, Buffer.from(data), {
      "Content-Type": "application/octet-stream",
    });
    const item = await this.stat(normalized);
    if (!item) throw new Error(`上传后无法读取远程文件：${normalized}`);
    return item;
  }

  private async ensureDirectory(path: string, pathIncludesRoot = false): Promise<void> {
    const relative = pathIncludesRoot ? "" : cleanPath(path);
    const segments = relative ? relative.split("/") : [];
    for (let i = 0; i <= segments.length; i++) {
      const partial = segments.slice(0, i).join("/");
      if (!partial && !this.remoteRoot) continue;
      try {
        await this.request("MKCOL", partial);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("HTTP 405") && !message.includes("HTTP 301")) throw error;
      }
    }
  }

  private propfind(path: string, depth: "0" | "infinity"): Promise<DavResponse> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop>
      </d:propfind>`;
    return this.request("PROPFIND", path, Buffer.from(body), {
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
    });
  }

  private parsePropfind(xml: string): Map<string, DavItem> {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("服务器返回了无法解析的 WebDAV XML");

    const result = new Map<string, DavItem>();
    const rootPath = decodeURIComponent(this.rootUrl().pathname).replace(/\/+$/, "");
    const responses = Array.from(document.getElementsByTagNameNS("DAV:", "response"));

    for (const node of responses) {
      const href = node.getElementsByTagNameNS("DAV:", "href")[0]?.textContent ?? "";
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(href, this.baseUrl).pathname).replace(/\/+$/, "");
      } catch {
        continue;
      }
      if (pathname !== rootPath && !pathname.startsWith(rootPath + "/")) continue;
      const relative = cleanPath(pathname.slice(rootPath.length));
      if (!relative) continue;

      const isDirectory = node.getElementsByTagNameNS("DAV:", "collection").length > 0;
      const sizeText = node.getElementsByTagNameNS("DAV:", "getcontentlength")[0]?.textContent ?? "0";
      const modifiedText = node.getElementsByTagNameNS("DAV:", "getlastmodified")[0]?.textContent ?? "";
      const etag = node.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent?.trim() ?? "";
      result.set(relative, {
        path: relative,
        isDirectory,
        size: Number.parseInt(sizeText, 10) || 0,
        modified: Date.parse(modifiedText) || 0,
        etag,
      });
    }
    return result;
  }

  private rootUrl(): URL {
    const url = new URL(this.baseUrl.toString());
    const suffix = this.remoteRoot ? encodePath(this.remoteRoot) + "/" : "";
    url.pathname = url.pathname.replace(/\/+$/, "/") + suffix;
    return url;
  }

  private urlFor(relativePath: string): URL {
    const url = this.rootUrl();
    const path = cleanPath(relativePath);
    if (path) url.pathname = url.pathname.replace(/\/+$/, "/") + encodePath(path);
    return url;
  }

  private makeAgent(target: URL): http.Agent | https.Agent | undefined {
    const proxy = this.settings.proxyUrl.trim();
    if (!proxy) {
      if (target.protocol === "https:") {
        return new https.Agent({ rejectUnauthorized: this.settings.rejectUnauthorized });
      }
      return undefined;
    }
    if (/^socks/i.test(proxy)) return new SocksProxyAgent(proxy);
    if (target.protocol === "https:") {
      return new HttpsProxyAgent(proxy, { rejectUnauthorized: this.settings.rejectUnauthorized });
    }
    return new HttpProxyAgent(proxy);
  }

  private request(
    method: string,
    path: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<DavResponse> {
    const target = this.urlFor(path);
    const transport = target.protocol === "https:" ? https : http;
    const authorization = Buffer.from(`${this.settings.username}:${this.settings.password}`).toString("base64");
    const headers: Record<string, string | number> = {
      Authorization: `Basic ${authorization}`,
      "User-Agent": "Obsidian-WebDAV-Proxy-Sync/0.1.0",
      ...extraHeaders,
    };
    if (body) headers["Content-Length"] = body.byteLength;

    return new Promise((resolve, reject) => {
      const request = transport.request(
        target,
        {
          method,
          headers,
          agent: this.makeAgent(target),
          timeout: 30_000,
          rejectUnauthorized: this.settings.rejectUnauthorized,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            const result: DavResponse = {
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            };
            if (result.status >= 200 && result.status < 300) {
              resolve(result);
              return;
            }
            const hint = result.status === 401
              ? "（请检查用户名和密码）"
              : result.status === 405
                ? "（请检查 WebDAV 地址；OpenList 通常以 /dav 结尾）"
                : "";
            reject(new Error(`HTTP ${result.status} ${method} ${target.pathname} ${hint}`));
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("连接超时")));
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}

export default class WebDavProxySyncPlugin extends Plugin {
  data: PluginData = { ...DEFAULT_DATA };
  private intervalId: number | null = null;
  private syncing = false;
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PluginData> | null;
    this.data = { ...DEFAULT_DATA, ...(loaded ?? {}), syncState: loaded?.syncState ?? {} };

    this.addRibbonIcon("refresh-cw", "WebDAV 代理同步", () => void this.runSync(true));
    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => void this.runSync(true),
    });
    this.addCommand({
      id: "test-webdav-connection",
      name: "测试 WebDAV 连接",
      callback: () => void this.testConnection(),
    });
    this.statusBar = this.addStatusBarItem();
    this.setStatus("WebDAV：待机");
    this.addSettingTab(new WebDavProxySyncSettingTab(this.app, this));
    this.configureInterval();

    if (this.data.syncOnStartup && this.data.serverUrl) {
      this.app.workspace.onLayoutReady(() => window.setTimeout(() => void this.runSync(false), 1500));
    }
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
    this.configureInterval();
  }

  async testConnection(): Promise<void> {
    try {
      this.setStatus("WebDAV：正在测试…");
      await new WebDavClient(this.data).test();
      new Notice("WebDAV 连接成功");
      this.setStatus("WebDAV：连接正常");
    } catch (error) {
      const message = errorMessage(error);
      new Notice(`WebDAV 连接失败：${message}`, 10_000);
      this.setStatus("WebDAV：连接失败");
      console.error("WebDAV connection test failed", error);
    }
  }

  async runSync(showNotice: boolean): Promise<void> {
    if (this.syncing) {
      if (showNotice) new Notice("WebDAV 正在同步中");
      return;
    }
    if (!this.data.serverUrl.trim()) {
      new Notice("请先配置 WebDAV 地址");
      return;
    }

    this.syncing = true;
    this.setStatus("WebDAV：同步中…");
    let uploaded = 0;
    let downloaded = 0;
    let conflicts = 0;

    try {
      const client = new WebDavClient(this.data);
      const remote = await client.list();
      const local = new Map<string, TFile>();
      for (const file of this.app.vault.getFiles()) {
        if (!this.isExcluded(file.path)) local.set(file.path, file);
      }
      for (const [path, item] of Array.from(remote.entries())) {
        if (item.isDirectory || this.isExcluded(path)) remote.delete(path);
      }

      const paths = new Set([...local.keys(), ...remote.keys()]);
      for (const path of Array.from(paths).sort()) {
        const localFile = local.get(path);
        const remoteItem = remote.get(path);
        const previous = this.data.syncState[path];

        if (localFile && !remoteItem) {
          const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile) this.setState(path, current, uploadedItem);
          uploaded++;
          continue;
        }

        if (!localFile && remoteItem) {
          const created = await this.writeRemoteFile(path, await client.download(path), remoteItem.modified);
          this.setState(path, created, remoteItem);
          downloaded++;
          continue;
        }

        if (!localFile || !remoteItem) continue;
        const localSig = signatureLocal(localFile);
        const remoteSig = signatureRemote(remoteItem);

        if (!previous) {
          if (localFile.stat.size === remoteItem.size && Math.abs(localFile.stat.mtime - remoteItem.modified) < 2000) {
            this.setState(path, localFile, remoteItem);
          } else if (localFile.stat.mtime >= remoteItem.modified) {
            const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
            const current = this.app.vault.getAbstractFileByPath(path);
            if (current instanceof TFile) this.setState(path, current, uploadedItem);
            uploaded++;
          } else {
            const updated = await this.writeRemoteFile(path, await client.download(path), remoteItem.modified);
            this.setState(path, updated, remoteItem);
            downloaded++;
          }
          continue;
        }

        const localChanged = previous.localSig !== localSig;
        const remoteChanged = previous.remoteSig !== remoteSig;
        if (!localChanged && !remoteChanged) continue;

        if (localChanged && remoteChanged) {
          await this.createConflictCopy(localFile);
          const updated = await this.writeRemoteFile(path, await client.download(path), remoteItem.modified);
          this.setState(path, updated, remoteItem);
          conflicts++;
        } else if (localChanged) {
          const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile) this.setState(path, current, uploadedItem);
          uploaded++;
        } else {
          const updated = await this.writeRemoteFile(path, await client.download(path), remoteItem.modified);
          this.setState(path, updated, remoteItem);
          downloaded++;
        }
      }

      await this.saveData(this.data);
      const summary = `上传 ${uploaded}，下载 ${downloaded}，冲突 ${conflicts}`;
      this.setStatus(`WebDAV：${summary}`);
      if (showNotice || uploaded + downloaded + conflicts > 0) new Notice(`WebDAV 同步完成：${summary}`);
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus("WebDAV：同步失败");
      new Notice(`WebDAV 同步失败：${message}`, 10_000);
      console.error("WebDAV sync failed", error);
    } finally {
      this.syncing = false;
    }
  }

  private async writeRemoteFile(path: string, data: ArrayBuffer, modified: number): Promise<TFile> {
    const normalized = normalizePath(path);
    await this.ensureLocalParent(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    let file: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data, modified ? { mtime: modified } : undefined);
      file = existing;
    } else {
      file = await this.app.vault.createBinary(normalized, data, modified ? { mtime: modified } : undefined);
    }
    return file;
  }

  private async ensureLocalParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  private async createConflictCopy(file: TFile): Promise<void> {
    const dot = file.path.lastIndexOf(".");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = dot > file.path.lastIndexOf("/") ? file.path.slice(0, dot) : file.path;
    const extension = dot > file.path.lastIndexOf("/") ? file.path.slice(dot) : "";
    let conflictPath = `${base}.conflict-local-${stamp}${extension}`;
    let index = 1;
    while (this.app.vault.getAbstractFileByPath(conflictPath)) {
      conflictPath = `${base}.conflict-local-${stamp}-${index++}${extension}`;
    }
    await this.ensureLocalParent(conflictPath);
    await this.app.vault.createBinary(conflictPath, await this.app.vault.readBinary(file));
  }

  private setState(path: string, local: TFile, remote: DavItem): void {
    this.data.syncState[path] = {
      localSig: signatureLocal(local),
      remoteSig: signatureRemote(remote),
    };
  }

  private isExcluded(path: string): boolean {
    const patterns = this.data.excludes.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return patterns.some((pattern) => globMatches(path, pattern));
  }

  private configureInterval(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.data.syncIntervalMinutes > 0) {
      this.intervalId = window.setInterval(
        () => void this.runSync(false),
        this.data.syncIntervalMinutes * 60_000,
      );
    }
  }

  private setStatus(text: string): void {
    if (this.statusBar) this.statusBar.setText(text);
  }
}

class WebDavProxySyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WebDavProxySyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "WebDAV 代理同步" });
    containerEl.createEl("p", {
      text: "仅支持桌面版。密码保存在本地插件配置中，请确保设备可信。首次正式同步前建议备份仓库。",
      cls: "webdav-proxy-sync-status",
    });

    new Setting(containerEl)
      .setName("WebDAV 地址")
      .setDesc("填写真正的 WebDAV 入口，例如 OpenList：https://example.com/dav")
      .addText((text) => text
        .setPlaceholder("https://example.com/dav")
        .setValue(this.plugin.data.serverUrl)
        .onChange(async (value) => { this.plugin.data.serverUrl = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("用户名")
      .addText((text) => text
        .setValue(this.plugin.data.username)
        .onChange(async (value) => { this.plugin.data.username = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("密码")
      .setDesc("保存在本机的插件 data.json 中")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.data.password)
          .onChange(async (value) => { this.plugin.data.password = value; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("远程目录")
      .setDesc("插件会在 WebDAV 根目录下创建此目录")
      .addText((text) => text
        .setPlaceholder("obsidian")
        .setValue(this.plugin.data.remoteFolder)
        .onChange(async (value) => { this.plugin.data.remoteFolder = cleanPath(value); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("代理地址")
      .setDesc("支持 http://、https://、socks5:// 和 socks5h://；留空表示直连")
      .addText((text) => text
        .setPlaceholder("socks5h://127.0.0.1:7890")
        .setValue(this.plugin.data.proxyUrl)
        .onChange(async (value) => { this.plugin.data.proxyUrl = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("验证 HTTPS 证书")
      .setDesc("建议保持开启；仅在使用可信的自签名证书时关闭")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.rejectUnauthorized)
        .onChange(async (value) => { this.plugin.data.rejectUnauthorized = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("自动同步间隔（分钟）")
      .setDesc("设为 0 可关闭定时同步")
      .addText((text) => text
        .setValue(String(this.plugin.data.syncIntervalMinutes))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.data.syncIntervalMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("启动后同步")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.syncOnStartup)
        .onChange(async (value) => { this.plugin.data.syncOnStartup = value; await this.plugin.saveSettings(); }));

    const excludes = new Setting(containerEl)
      .setName("排除规则")
      .setDesc("每行一条简单 glob 规则；默认不同步 .obsidian 和回收站")
      .setClass("webdav-proxy-sync-setting");
    excludes.addTextArea((text) => text
      .setValue(this.plugin.data.excludes)
      .onChange(async (value) => { this.plugin.data.excludes = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("连接测试")
      .setDesc("测试服务器、账号以及代理设置")
      .addButton((button) => button
        .setButtonText("测试连接")
        .onClick(() => void this.plugin.testConnection()));

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("默认不会传播删除；发生双向修改时会保留本地冲突副本")
      .addButton((button) => button
        .setCta()
        .setButtonText("开始同步")
        .onClick(() => void this.plugin.runSync(true)));
  }
}

function cleanPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function encodePath(path: string): string {
  return cleanPath(path).split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function signatureLocal(file: TFile): string {
  return `${file.stat.size}:${file.stat.mtime}`;
}

function signatureRemote(item: DavItem): string {
  return item.etag ? `etag:${item.etag}` : `${item.size}:${item.modified}`;
}

function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
