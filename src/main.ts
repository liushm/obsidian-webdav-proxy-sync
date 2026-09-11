import {
  App,
  Notice,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  Platform,
  requestUrl,
  type SettingDefinitionItem,
} from "obsidian";

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
  requestTimeoutSeconds: number;
  downloadConcurrency: number;
  downloadRetryCount: number;
  downloadRetryDelaySeconds: number;
  excludes: string;
  logs: string[];
  syncStateVersion: number;
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
  headers: Record<string, string | string[] | undefined>;
  body: ArrayBuffer;
}

interface DownloadJob {
  path: string;
  remoteItem: DavItem;
  localFile?: TFile;
  conflict: boolean;
  position: number;
  total: number;
}

interface DownloadJobResult {
  job: DownloadJob;
  success: boolean;
  conflict: boolean;
  error?: unknown;
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
  requestTimeoutSeconds: 60,
  downloadConcurrency: 4,
  downloadRetryCount: 3,
  downloadRetryDelaySeconds: 2,
  excludes: ".trash/**\n**/.DS_Store\n**/Thumbs.db",
  logs: [],
  syncStateVersion: 2,
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
    return this.parsePropfind(new TextDecoder().decode(response.body));
  }

  async stat(path: string): Promise<DavItem | null> {
    try {
      const response = await this.propfind(path, "0");
      return this.parsePropfind(new TextDecoder().decode(response.body)).get(cleanPath(path)) ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) return null;
      throw error;
    }
  }

  async download(
    path: string,
    expectedItem: DavItem,
    onRetry?: (retryNumber: number, maxRetries: number, error: unknown) => void,
  ): Promise<{ data: ArrayBuffer; item: DavItem }> {
    const maxRetries = clampInteger(this.settings.downloadRetryCount, 0, 10);
    // Some storage drivers (notably OpenList backed by Quark) respond with HTTP
    // 416 when asked to GET a valid zero-byte file. WebDAV metadata is enough to
    // materialize such a file locally without issuing the broken GET request.
    if (expectedItem.size === 0) {
      return { data: new ArrayBuffer(0), item: expectedItem };
    }
    let data: ArrayBuffer | null = null;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.request("GET", path, undefined, {
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        });
        data = response.body;
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetriableDownloadError(error)) throw error;
        const retryNumber = attempt + 1;
        onRetry?.(retryNumber, maxRetries, error);
        await sleep(this.retryDelay(retryNumber));
      }
    }

    if (!data) throw lastError ?? new Error(`下载失败：${path}`);

    // Some WebDAV backends refresh the file timestamp/ETag after a GET. Query
    // metadata separately with retries so a transient PROPFIND failure does not
    // force another transfer of a potentially large file.
    let item: DavItem | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        item = await this.stat(path);
        if (item) break;
        throw new Error(`下载后无法读取远程文件信息：${path}`);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetriableDownloadError(error)) throw error;
        const retryNumber = attempt + 1;
        onRetry?.(retryNumber, maxRetries, error);
        await sleep(this.retryDelay(retryNumber));
      }
    }
    if (!item) throw lastError ?? new Error(`下载后无法读取远程文件信息：${path}`);
    return { data, item };
  }

  private retryDelay(retryNumber: number): number {
    const base = clampInteger(this.settings.downloadRetryDelaySeconds, 0, 60) * 1000;
    return Math.min(30_000, base * Math.pow(2, Math.max(0, retryNumber - 1)));
  }

  async upload(path: string, data: ArrayBuffer): Promise<DavItem> {
    const normalized = cleanPath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDirectory(parent);
    await this.request("PUT", normalized, data, {
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
        if (message.includes("HTTP 301")) continue;
        if (!message.includes("HTTP 405")) throw error;
        // 405 usually means the collection already exists. Some OpenList-backed
        // storages expose a newly-created directory after a short delay.
        if (!partial) continue;
        let available = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          const item = await this.stat(partial);
          if (item?.isDirectory) {
            available = true;
            break;
          }
          await sleep(400 * (attempt + 1));
        }
        if (!available) throw new Error(`无法创建或访问远程目录：${partial}；${message}`);
      }
    }
  }

  private propfind(path: string, depth: "0" | "infinity"): Promise<DavResponse> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop>
      </d:propfind>`;
    return this.request("PROPFIND", path, body, {
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

  private async request(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<DavResponse> {
    const target = this.urlFor(path);
    if (Platform.isMobileApp || (!this.settings.proxyUrl.trim() && this.settings.rejectUnauthorized)) {
      return this.requestPortable(method, target, body, extraHeaders);
    }
    return this.requestDesktop(method, target, body, extraHeaders);
  }

  private async requestPortable(
    method: string,
    target: URL,
    body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<DavResponse> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${basicAuth(this.settings.username, this.settings.password)}`,
      ...extraHeaders,
    };
    const timeoutMs = Math.max(5, this.settings.requestTimeoutSeconds) * 1000;
    const response = await withTimeout(
      requestUrl({
        url: target.toString(),
        method,
        headers,
        body,
        throw: false,
      }),
      timeoutMs,
    );
    const result: DavResponse = {
      status: response.status,
      headers: response.headers,
      body: response.arrayBuffer,
    };
    this.throwForStatus(result.status, method, target);
    return result;
  }

  private async requestDesktop(
    method: string,
    target: URL,
    body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<DavResponse> {
    // Obsidian desktop exposes Node.js through CommonJS. Keep these requires
    // inside the desktop-only branch so mobile never evaluates Node APIs.
    // Native dynamic import (import("node:http")) is not supported by Obsidian's
    // plugin loader and is treated like a browser module fetch.
    const http = require("http") as typeof import("http");
    const https = require("https") as typeof import("https");
    const proxy = this.settings.proxyUrl.trim();
    let agent: import("node:http").Agent | import("node:https").Agent | undefined;
    if (!proxy) {
      agent = target.protocol === "https:"
        ? new https.Agent({ rejectUnauthorized: this.settings.rejectUnauthorized })
        : undefined;
    } else if (/^socks/i.test(proxy)) {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      agent = new SocksProxyAgent(proxy);
    } else if (target.protocol === "https:") {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new HttpsProxyAgent(proxy, { rejectUnauthorized: this.settings.rejectUnauthorized });
    } else {
      const { HttpProxyAgent } = await import("http-proxy-agent");
      agent = new HttpProxyAgent(proxy);
    }

    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body ? new Uint8Array(body) : undefined;
    const headers: Record<string, string | number> = {
      Authorization: `Basic ${basicAuth(this.settings.username, this.settings.password)}`,
      "User-Agent": "Obsidian-WebDAV-Proxy-Sync/0.3.2",
      ...extraHeaders,
    };
    if (bytes) headers["Content-Length"] = bytes.byteLength;
    const transport = target.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method,
        headers,
        agent,
        timeout: Math.max(5, this.settings.requestTimeoutSeconds) * 1000,
        rejectUnauthorized: this.settings.rejectUnauthorized,
      }, (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
        response.on("end", () => {
          const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const combined = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const result: DavResponse = {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: combined.buffer,
          };
          try {
            this.throwForStatus(result.status, method, target);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("连接超时")));
      req.on("error", reject);
      if (bytes) req.write(bytes);
      req.end();
    });
  }

  private throwForStatus(status: number, method: string, target: URL): void {
    if (status >= 200 && status < 300) return;
    const hint = status === 401
      ? "（请检查用户名和密码）"
      : status === 405
        ? "（服务器拒绝了该 WebDAV 操作，请检查路径、权限或同名冲突）"
        : "";
    throw new Error(`HTTP ${status} ${method} ${target.pathname} ${hint}`);
  }
}

export default class WebDavProxySyncPlugin extends Plugin {
  data: PluginData = { ...DEFAULT_DATA };
  private intervalId: number | null = null;
  private syncing = false;
  private statusBar: HTMLElement | null = null;
  private needsStateMigration = false;

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PluginData> | null;
    this.needsStateMigration = (loaded?.syncStateVersion ?? 1) < 2;
    this.data = {
      ...DEFAULT_DATA,
      ...(loaded ?? {}),
      logs: loaded?.logs ?? [],
      syncStateVersion: loaded?.syncStateVersion ?? 1,
      syncState: loaded?.syncState ?? {},
    };

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
    this.addCommand({
      id: "show-sync-log",
      name: "查看同步日志",
      callback: () => this.showLogs(),
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.onclick = () => this.showLogs();
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
      this.addLog("INFO", "开始测试 WebDAV 连接");
      await new WebDavClient(this.data).test();
      this.addLog("INFO", "WebDAV 连接测试成功");
      await this.saveData(this.data);
      new Notice("WebDAV 连接成功");
      this.setStatus("WebDAV：连接正常");
    } catch (error) {
      const message = errorMessage(error);
      this.addLog("ERROR", `连接测试失败：${message}${errorStack(error)}`);
      await this.saveData(this.data);
      new Notice(`WebDAV 连接失败：${message}。可在命令面板中打开“查看同步日志”。`, 10_000);
      this.setStatus(`WebDAV：连接失败 · ${message}`);
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
    this.setStatus("WebDAV：正在读取远程文件列表…");
    this.addLog("INFO", "开始同步");
    let uploaded = 0;
    let downloaded = 0;
    let conflicts = 0;
    let failedDownloads = 0;
    let currentPath = "";

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
      const sortedPaths = Array.from(paths).sort();
      const downloadJobs: DownloadJob[] = [];
      this.addLog("INFO", `扫描完成：本地 ${local.size} 个文件，远程 ${remote.size} 个文件，共需比较 ${sortedPaths.length} 个路径`);
      let processed = 0;

      const queueDownload = (path: string, remoteItem: DavItem, localFile?: TFile, conflict = false): void => {
        downloadJobs.push({ path, remoteItem, localFile, conflict, position: processed, total: sortedPaths.length });
      };

      for (const path of sortedPaths) {
        currentPath = path;
        processed++;
        this.setStatus(`WebDAV：${processed}/${sortedPaths.length} · 检查 ${shortPath(path)}`);
        const localFile = local.get(path);
        const remoteItem = remote.get(path);
        const previous = this.data.syncState[path];

        if (localFile && !remoteItem) {
          this.setStatus(`WebDAV：${processed}/${sortedPaths.length} · 上传 ${shortPath(path)}`);
          const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile) await this.setState(path, current, uploadedItem);
          uploaded++;
          this.addLog("INFO", `上传：${path}`);
          continue;
        }

        if (!localFile && remoteItem) {
          queueDownload(path, remoteItem);
          continue;
        }

        if (!localFile || !remoteItem) continue;
        const localSig = signatureLocal(localFile);
        const remoteSig = signatureRemote(remoteItem);

        if (!previous) {
          if (localFile.stat.size === remoteItem.size) {
            await this.setState(path, localFile, remoteItem);
            this.addLog("INFO", `建立基线（大小一致，无需传输）：${path}`);
          } else if (localFile.stat.mtime >= remoteItem.modified) {
            this.setStatus(`WebDAV：${processed}/${sortedPaths.length} · 上传 ${shortPath(path)}`);
            const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
            const current = this.app.vault.getAbstractFileByPath(path);
            if (current instanceof TFile) await this.setState(path, current, uploadedItem);
            uploaded++;
            this.addLog("INFO", `上传：${path}`);
          } else {
            queueDownload(path, remoteItem, localFile);
          }
          continue;
        }

        if (this.needsStateMigration && localFile.stat.size === remoteItem.size) {
          await this.setState(path, localFile, remoteItem);
          continue;
        }

        const localChanged = previous.localSig !== localSig;
        const remoteChanged = previous.remoteSig !== remoteSig;
        if (!localChanged && !remoteChanged) continue;

        if (localChanged && remoteChanged) {
          queueDownload(path, remoteItem, localFile, true);
        } else if (localChanged) {
          this.setStatus(`WebDAV：${processed}/${sortedPaths.length} · 上传 ${shortPath(path)}`);
          const uploadedItem = await client.upload(path, await this.app.vault.readBinary(localFile));
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile) await this.setState(path, current, uploadedItem);
          uploaded++;
          this.addLog("INFO", `上传：${path}`);
        } else {
          queueDownload(path, remoteItem, localFile);
        }
      }

      if (downloadJobs.length > 0) {
        const concurrency = clampInteger(this.data.downloadConcurrency, 1, 8);
        this.addLog("INFO", `待下载 ${downloadJobs.length} 个文件，并发数 ${concurrency}，单文件最多重试 ${this.data.downloadRetryCount} 次`);
        currentPath = "";
        const result = await this.executeDownloadJobs(client, downloadJobs, concurrency);
        downloaded += result.downloaded;
        conflicts += result.conflicts;
        failedDownloads += result.failed;
      }

      const summary = `上传 ${uploaded}，下载 ${downloaded}，冲突 ${conflicts}，下载失败 ${failedDownloads}`;
      this.addLog("INFO", `同步完成：${summary}`);
      this.data.syncStateVersion = 2;
      this.needsStateMigration = false;
      await this.saveData(this.data);
      this.setStatus(`WebDAV：${summary}`);
      if (showNotice || uploaded + downloaded + conflicts + failedDownloads > 0) new Notice(`WebDAV 同步完成：${summary}`);
    } catch (error) {
      const message = errorMessage(error);
      const location = currentPath ? `，最近处理：${currentPath}` : "";
      this.addLog("ERROR", `同步失败${location}：${message}${errorStack(error)}`);
      await this.saveData(this.data);
      this.setStatus(`WebDAV：同步失败 · ${message}`);
      new Notice(`WebDAV 同步失败：${message}${location}。可打开“查看同步日志”查看详情。`, 12_000);
    } finally {
      this.syncing = false;
    }
  }

  private async executeDownloadJobs(
    client: WebDavClient,
    jobs: DownloadJob[],
    concurrency: number,
  ): Promise<{ downloaded: number; conflicts: number; failed: number }> {
    let downloaded = 0;
    let conflicts = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    let consecutiveFailedPaths: string[] = [];

    // Create parent directories before starting concurrent writes to avoid races
    // where two downloads try to create the same local folder simultaneously.
    for (const job of jobs) await this.ensureLocalParent(job.path);

    for (let offset = 0; offset < jobs.length; offset += concurrency) {
      const batch = jobs.slice(offset, offset + concurrency);
      const results = await Promise.all(batch.map((job) => this.executeDownloadJob(client, job)));
      let shouldAbort = false;

      for (const result of results) {
        if (result.success) {
          downloaded++;
          if (result.conflict) conflicts++;
          consecutiveFailures = 0;
          consecutiveFailedPaths = [];
        } else {
          failed++;
          consecutiveFailures++;
          consecutiveFailedPaths.push(result.job.path);
          const message = errorMessage(result.error);
          this.addLog("ERROR", `下载最终失败（已重试）：${result.job.path}：${message}${errorStack(result.error)}`);
          if (consecutiveFailures >= 3) shouldAbort = true;
        }
      }

      await this.saveData(this.data);
      if (shouldAbort) {
        throw new Error(`连续 ${consecutiveFailures} 个文件下载失败，已中断本次同步：${consecutiveFailedPaths.join("、")}；本轮共成功 ${downloaded} 个、失败 ${failed} 个`);
      }
    }
    return { downloaded, conflicts, failed };
  }

  private async executeDownloadJob(client: WebDavClient, job: DownloadJob): Promise<DownloadJobResult> {
    try {
      this.setStatus(`WebDAV：下载 ${job.position}/${job.total} · ${shortPath(job.path)}`);
      const downloadedFile = await client.download(job.path, job.remoteItem, (retryNumber, maxRetries, error) => {
        this.addLog("WARN", `下载重试 ${retryNumber}/${maxRetries}：${job.path}：${errorMessage(error)}`);
        this.setStatus(`WebDAV：重试 ${retryNumber}/${maxRetries} · ${shortPath(job.path)}`);
      });
      if (job.conflict && job.localFile) await this.createConflictCopy(job.localFile);
      const updated = await this.writeRemoteFile(job.path, downloadedFile.data, downloadedFile.item.modified);
      await this.setState(job.path, updated, downloadedFile.item);
      if (job.conflict) this.addLog("WARN", `双向冲突，已保留本地副本：${job.path}`);
      else this.addLog("INFO", `下载：${job.path}`);
      return { job, success: true, conflict: job.conflict };
    } catch (error) {
      return { job, success: false, conflict: false, error };
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

  private async setState(path: string, local: TFile, remote: DavItem): Promise<void> {
    const stat = await this.app.vault.adapter.stat(path);
    this.data.syncState[path] = {
      localSig: stat ? `${stat.size}:${stat.mtime}` : signatureLocal(local),
      remoteSig: signatureRemote(remote),
    };
  }

  private isExcluded(path: string): boolean {
    const configDir = cleanPath(this.app.vault.configDir);
    if (path === configDir || path.startsWith(`${configDir}/`)) return true;
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

  showLogs(): void {
    new SyncLogModal(this.app, this).open();
  }

  async clearLogs(): Promise<void> {
    this.data.logs = [];
    await this.saveData(this.data);
  }

  private addLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
    const line = `${new Date().toLocaleString()} [${level}] ${message}`;
    this.data.logs.push(line);
    if (this.data.logs.length > 300) this.data.logs.splice(0, this.data.logs.length - 300);

  }

  private setStatus(text: string): void {
    if (this.statusBar) {
      this.statusBar.setText(text);
      this.statusBar.setAttr("title", text);
    }
  }
}

class SyncLogModal extends Modal {
  constructor(app: App, private readonly plugin: WebDavProxySyncPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("WebDAV 同步日志").setHeading();
    const toolbar = contentEl.createDiv({ cls: "webdav-proxy-sync-log-toolbar" });
    const copyButton = toolbar.createEl("button", { text: "复制日志" });
    copyButton.onclick = () => {
      void navigator.clipboard.writeText(this.plugin.data.logs.join("\n"));
      new Notice("同步日志已复制");
    };
    const clearButton = toolbar.createEl("button", { text: "清空日志" });
    clearButton.onclick = async () => {
      await this.plugin.clearLogs();
      this.onOpen();
    };
    const log = contentEl.createEl("pre", { cls: "webdav-proxy-sync-log" });
    log.setText(this.plugin.data.logs.length ? this.plugin.data.logs.join("\n") : "暂无同步日志");
    log.scrollTop = log.scrollHeight;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class WebDavProxySyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WebDavProxySyncPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("WebDAV 代理同步").setHeading();
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
      .setDesc(Platform.isMobileApp
        ? "移动端使用系统网络，插件内代理设置仅在桌面端生效"
        : "支持 http://、https://、socks5:// 和 socks5h://；留空表示直连")
      .addText((text) => text
        .setDisabled(Platform.isMobileApp)
        .setPlaceholder("socks5h://127.0.0.1:7890")
        .setValue(this.plugin.data.proxyUrl)
        .onChange(async (value) => { this.plugin.data.proxyUrl = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("验证 HTTPS 证书")
      .setDesc("建议保持开启；仅在使用可信的自签名证书时关闭")
      .addToggle((toggle) => toggle
        .setDisabled(Platform.isMobileApp)
        .setValue(this.plugin.data.rejectUnauthorized)
        .onChange(async (value) => { this.plugin.data.rejectUnauthorized = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("网络超时（秒）")
      .setDesc("网络或代理较慢时可适当增大，例如 120 秒")
      .addText((text) => text
        .setValue(String(this.plugin.data.requestTimeoutSeconds))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.data.requestTimeoutSeconds = Number.isFinite(parsed) && parsed >= 5 ? parsed : 60;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("并发下载数")
      .setDesc("同时下载的文件数，建议 3–6；过高可能触发 WebDAV 服务限流")
      .addText((text) => text
        .setValue(String(this.plugin.data.downloadConcurrency))
        .onChange(async (value) => {
          this.plugin.data.downloadConcurrency = clampInteger(Number.parseInt(value, 10), 1, 8);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("下载重试次数")
      .setDesc("单个文件下载失败后的重试次数；HTTP 416、超时和服务器临时错误会自动重试")
      .addText((text) => text
        .setValue(String(this.plugin.data.downloadRetryCount))
        .onChange(async (value) => {
          this.plugin.data.downloadRetryCount = clampInteger(Number.parseInt(value, 10), 0, 10);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("重试基础间隔（秒）")
      .setDesc("按指数退避等待，例如设置 2 秒时依次等待 2、4、8 秒")
      .addText((text) => text
        .setValue(String(this.plugin.data.downloadRetryDelaySeconds))
        .onChange(async (value) => {
          this.plugin.data.downloadRetryDelaySeconds = clampInteger(Number.parseInt(value, 10), 0, 60);
          await this.plugin.saveSettings();
        }));

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
      .setDesc("每行一条简单 glob 规则；默认不同步当前仓库配置目录和回收站")
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
      .setName("同步日志")
      .setDesc("查看每次同步的扫描数量、文件操作、失败位置和错误堆栈")
      .addButton((button) => button
        .setButtonText("查看日志")
        .onClick(() => this.plugin.showLogs()));

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
  let expression = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(path);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function httpStatusFromError(error: unknown): number | null {
  const match = errorMessage(error).match(/HTTP\s+(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isRetriableDownloadError(error: unknown): boolean {
  const status = httpStatusFromError(error);
  if (status === null) return true;
  return status === 408
    || status === 409
    || status === 416
    || status === 423
    || status === 425
    || status === 429
    || status >= 500;
}

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("连接超时")), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function shortPath(path: string): string {
  return path.length > 48 ? `…${path.slice(-47)}` : path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "";
  const stack = error.stack.split("\n").slice(1, 8).join(" | ");
  return stack ? ` | ${stack.trim()}` : "";
}
