import { exec, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { createLogger } from '@snowluma/common/logger';
import type { HookManager } from '@snowluma/bridge';
import type { Hono } from 'hono';

const execAsync = promisify(exec);
const log = createLogger('QqLogin');

const DISPLAY = process.env.DISPLAY || ':99';
/** 容器内 QQ 主程序（ELF，无包装脚本）。 */
export const QQ_BINARY = '/opt/QQ/qq';
/**
 * HOME 隔离多实例的数据目录根。运行时 cwd 即持久化数据卷（Docker 内为
 * /app/data），实例数据随卷持久化。
 */
export const INSTANCES_ROOT = path.resolve(process.cwd(), 'qq-instances');
/** 额外 QQ 实例数量上限，防止误触连开拖垮容器。 */
export const MAX_LAUNCHED_INSTANCES = 3;
/**
 * 隔离实例的屏幕资源分配：实例 instance-N 使用显示器 :{99+N}
 * （N=1..3 → :100..:102）、x11vnc 内部端口 {5920+N}、noVNC 对外端口 {5901+N}。
 * 默认实例由 entrypoint 托管在 :99，noVNC 固定 5901。
 */
export const INSTANCE_DISPLAY_BASE = 99;
export const INSTANCE_VNC_BASE = 5920;
export const INSTANCE_NOVNC_BASE = 5901;
export const DEFAULT_NOVNC_PORT = 5901;
const XVFB_GEOMETRY = process.env.XVFB_SCREEN || '1280x720x24';
const NOVNC_WEB_ROOT = '/usr/share/novnc';
/** PID 合法性上限（与 server.ts 进程路由一致）。 */
const MAX_PID_LIMIT = 4_194_304;
const EXEC_TIMEOUT_MS = 8_000;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

export interface QqScreenRouteDependencies {
  hookManager: HookManager | null;
}

export interface QqProcessInfo {
  pid: number;
  /** 实例数据目录（HOME 覆盖值）；默认实例（非本模块启动）为 null。 */
  dataDir: string | null;
  source: 'default' | 'isolated';
  /** 进程的 X 显示器（如 :99 / :100）；解析失败为 null。 */
  display: number | null;
}

export interface QqInstanceStatus {
  pid: number;
  dataDir: string | null;
  source: 'default' | 'isolated';
  display: number | null;
  noVncPort: number | null;
  injected: boolean;
  loggedIn: boolean;
  status: string;
  uin: string;
}

/** 实例注册表：记录该实例专属屏幕进程与端口，随数据目录持久化。 */
export interface InstanceRegistry {
  display: number;
  vncPort: number;
  noVncPort: number;
  pids: { xvfb?: number; x11vnc?: number; websockify?: number; qq?: number };
  createdAt: string;
}

const REGISTRY_FILE = '.snowluma-instance.json';

export function registryPath(dataDir: string): string {
  return path.join(dataDir, REGISTRY_FILE);
}

export function readInstanceRegistry(dataDir: string): InstanceRegistry | null {
  try {
    const raw = JSON.parse(readFileSync(registryPath(dataDir), 'utf8')) as Partial<InstanceRegistry>;
    if (typeof raw.display !== 'number' || typeof raw.vncPort !== 'number' || typeof raw.noVncPort !== 'number') {
      return null;
    }
    return { ...raw, pids: raw.pids ?? {}, createdAt: raw.createdAt ?? '' } as InstanceRegistry;
  } catch {
    return null;
  }
}

function writeInstanceRegistry(dataDir: string, registry: InstanceRegistry): void {
  try {
    writeFileSync(registryPath(dataDir), JSON.stringify(registry, null, 2));
  } catch (err) {
    log.warn('write registry failed dataDir=%s: %s', dataDir, err instanceof Error ? err.message : String(err));
  }
}

/** 解析 `/proc/<pid>/environ` 的 NUL 分隔文本。 */
export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function parseDisplayNumber(value: string | undefined): number | null {
  if (!value || !value.startsWith(':')) return null;
  const num = Number(value.slice(1));
  return Number.isInteger(num) && num >= 0 ? num : null;
}

/**
 * 枚举当前存活的 QQ 主进程（跳过 Electron 子进程）。
 * Electron 子进程的形如 `--type=zygote` / `--type=gpu-process`（带值参数），
 * 必须用前缀匹配过滤——精确相等匹配永远为 false，会把全部子进程误判为主进程。
 * 逐 pid 读取并在 ENOENT（进程已退出）时静默跳过——/proc 扫描天然存在竞态。
 */
export function findQqMainProcesses(procRoot = '/proc'): QqProcessInfo[] {
  const out: QqProcessInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const cmdline = readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8');
      const argv = cmdline.split('\0').filter(Boolean);
      if (argv.length === 0) continue;
      if (path.basename(argv[0]) !== 'qq') continue;
      if (argv.some((a) => a.startsWith('--type='))) continue;
      const rawArg = argv.find((a) => a.startsWith('--user-data-dir='));
      let dataDir: string | null = null;
      let source: QqProcessInfo['source'] = 'default';
      if (rawArg) {
        dataDir = rawArg.slice('--user-data-dir='.length) || null;
        source = 'isolated';
      } else {
        const environ = parseEnviron(readFileSync(path.join(procRoot, entry, 'environ'), 'utf8'));
        const home = environ.HOME;
        if (home && home.includes('qq-instances')) {
          dataDir = home;
          source = 'isolated';
        }
      }
      const environ = parseEnviron(readFileSync(path.join(procRoot, entry, 'environ'), 'utf8'));
      out.push({ pid, dataDir, source, display: parseDisplayNumber(environ.DISPLAY) });
    } catch {
      // 进程在我们读取期间退出：正常竞态，直接跳过。
    }
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

function instanceIndexFromDir(dataDir: string): number | null {
  const match = /instance-(\d+)$/.exec(path.basename(dataDir));
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 1 && index <= MAX_LAUNCHED_INSTANCES ? index : null;
}

/**
 * 选出下一个可用的隔离实例数据目录：复用"目录存在但没有存活进程占用"的
 * 目录（上次启动失败的残留），否则取最小未用编号新建。
 */
export function nextInstanceDir(live: QqProcessInfo[] = findQqMainProcesses(), root = INSTANCES_ROOT): string {
  const occupied = new Set(live.filter((p) => p.source === 'isolated').map((p) => p.dataDir));
  for (let index = 1; index <= MAX_LAUNCHED_INSTANCES; index++) {
    const candidate = path.join(root, `instance-${index}`);
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`隔离实例数量已达上限（${MAX_LAUNCHED_INSTANCES} 个）`);
}

function spawnDetached(binary: string, args: string[], env: NodeJS.ProcessEnv): number {
  const child = spawn(binary, args, { env, stdio: 'ignore' });
  const pid = child.pid as number;
  child.on('error', (err: Error) => log.error('spawn %s failed: %s', binary, err.message));
  child.unref();
  return pid;
}

/** 在指定显示器上启动 QQ 主进程，并更新实例注册表中的 qq pid。 */
export function launchQqOnDisplay(dataDir: string, display: number, env = process.env): number {
  const pid = spawnDetached(QQ_BINARY, ['--no-sandbox'], { ...env, HOME: dataDir, DISPLAY: `:${display}` });
  const registry = readInstanceRegistry(dataDir);
  if (registry) {
    writeInstanceRegistry(dataDir, { ...registry, pids: { ...registry.pids, qq: pid } });
  }
  log.info('launched QQ pid=%d display=:%d dataDir=%s', pid, display, dataDir);
  return pid;
}

/**
 * 启动一个完全屏幕隔离的 QQ 实例：专属 Xvfb → x11vnc（仅容器内）→
 * noVNC（对外网页端口）→ QQ（独立 HOME + DISPLAY）。返回 QQ PID 与端口信息。
 */
export function launchIsolatedInstance(dataDir: string, env = process.env): {
  pid: number; display: number; vncPort: number; noVncPort: number;
} {
  const index = instanceIndexFromDir(dataDir);
  if (index == null) throw new Error(`实例目录名不合法：${dataDir}`);
  const display = INSTANCE_DISPLAY_BASE + index;
  const vncPort = INSTANCE_VNC_BASE + index;
  const noVncPort = INSTANCE_NOVNC_BASE + index;
  // 同显示器上已有存活的 Xvfb 时拒绝复用，避免两个实例画面串台。
  if (displayBusy(display)) throw new Error(`显示器 :${display} 已被占用`);
  mkdirSync(dataDir, { recursive: true });
  const childEnv = { ...env, DISPLAY: `:${display}` };
  const pids: InstanceRegistry['pids'] = {};
  pids.xvfb = spawnDetached('Xvfb', [`:${display}`, '-screen', '0', XVFB_GEOMETRY, '-nolisten', 'tcp'], childEnv);
  if (existsSync('/usr/bin/x11vnc')) {
    pids.x11vnc = spawnDetached('x11vnc',
      ['-display', `:${display}`, '-rfbport', String(vncPort), '-listen', 'localhost',
        '-forever', '-shared', '-nopw', '-quiet'], childEnv);
  }
  if (existsSync('/usr/bin/websockify') && existsSync(NOVNC_WEB_ROOT)) {
    pids.websockify = spawnDetached('websockify',
      ['--web', NOVNC_WEB_ROOT, String(noVncPort), `localhost:${vncPort}`], childEnv);
  }
  writeInstanceRegistry(dataDir, {
    display, vncPort, noVncPort, pids, createdAt: new Date().toISOString(),
  });
  const pid = launchQqOnDisplay(dataDir, display, env);
  log.info('launched isolated instance #%d display=:%d noVNC=%d dataDir=%s', index, display, noVncPort, dataDir);
  return { pid, display, vncPort, noVncPort };
}

/** 检查某显示器上是否已有存活的 Xvfb。 */
function displayBusy(display: number, procRoot = '/proc'): boolean {
  try {
    for (const entry of readdirSync(procRoot)) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        const cmdline = readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8');
        const argv = cmdline.split('\0').filter(Boolean);
        if (path.basename(argv[0] ?? '') === 'Xvfb' && argv.includes(`:${display}`)) return true;
      } catch { /* 竞态：进程已退出 */ }
    }
  } catch { /* /proc 不可读时按未占用处理 */ }
  return false;
}

/** 对 DISPLAY 截屏并编码为 PNG（xwd → xwdtopnm → pnmtopng 管道）。 */
export async function captureScreenPng(display = DISPLAY): Promise<Buffer> {
  const outFile = path.join(tmpdir(), `qq-login-screen-${process.pid}-${Date.now()}.png`);
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const script = `xwd -root -display ${quote(display)} | xwdtopnm | pnmtopng > ${quote(outFile)}`;
  try {
    await execAsync(script, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER });
    return readFileSync(outFile);
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** 终止指定 QQ 进程（默认 SIGTERM）。返回实际发送信号的 PID 列表。 */
export function terminateQqProcesses(pids: number[], signal: NodeJS.Signals = 'SIGTERM'): number[] {
  const terminated: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      terminated.push(pid);
    } catch (err) {
      log.warn('terminate pid=%d failed: %s', pid, err instanceof Error ? err.message : String(err));
    }
  }
  return terminated;
}

const TERM_GRACE_MS = 5_000;
const TERM_POLL_INTERVAL_MS = 300;

/** 轮询 /proc 直到进程消失或超时。 */
async function waitForExit(pid: number, timeoutMs = TERM_GRACE_MS, procRoot = '/proc'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path.join(procRoot, String(pid)))) return true;
    await new Promise((resolve) => setTimeout(resolve, TERM_POLL_INTERVAL_MS));
  }
  return !existsSync(path.join(procRoot, String(pid)));
}

/** 删除实例操作的业务错误；status 用于映射 HTTP 状态码。 */
export class QqInstanceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'QqInstanceError';
  }
}

/**
 * 删除隔离实例：终止 QQ 与其专属屏幕进程（Xvfb/x11vnc/websockify，SIGTERM
 * 宽限 → SIGKILL 兜底）并清除数据目录。仅允许 source === 'isolated' 的实例；
 * 默认实例由 entrypoint 托管，不可删除。
 */
export async function removeQqInstance(
  pid: number,
  procRoot = '/proc',
  root = INSTANCES_ROOT,
): Promise<{ dataDir: string }> {
  const proc = findQqMainProcesses(procRoot).find((p) => p.pid === pid);
  if (!proc) throw new QqInstanceError(404, '该实例不存在或已退出');
  if (proc.source !== 'isolated' || !proc.dataDir) {
    throw new QqInstanceError(400, '默认实例由容器托管，不可删除；如需重置请使用「重启登录窗口」');
  }
  // 路径安全：数据目录必须严格位于隔离实例根目录之下，防目录穿越误删。
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(proc.dataDir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw new QqInstanceError(400, '数据目录不在隔离实例目录内，拒绝删除');
  }
  if (terminateQqProcesses([pid], 'SIGTERM').length === 0) {
    throw new QqInstanceError(500, `终止进程 ${pid} 失败（权限或已退出）`);
  }
  if (!await waitForExit(pid, TERM_GRACE_MS, procRoot)) {
    terminateQqProcesses([pid], 'SIGKILL');
    if (!await waitForExit(pid, TERM_GRACE_MS, procRoot)) {
      throw new QqInstanceError(409, `进程 ${pid} 未能退出，数据目录未删除，请稍后重试`);
    }
  }
  // 回收该实例的专属屏幕进程（注册表优先，缺失时按注册表字段兜底为空）。
  const registry = readInstanceRegistry(resolvedDir);
  if (registry) {
    const screenPids = [registry.pids.xvfb, registry.pids.x11vnc, registry.pids.websockify]
      .filter((p): p is number => typeof p === 'number');
    terminateQqProcesses(screenPids, 'SIGTERM');
    for (const screenPid of screenPids) {
      if (!await waitForExit(screenPid, 2_000, procRoot)) terminateQqProcesses([screenPid], 'SIGKILL');
    }
    log.info('reclaimed screen processes for instance %s (display=:%d)', resolvedDir, registry.display);
  }
  rmSync(resolvedDir, { recursive: true, force: true });
  log.info('removed qq instance pid=%d dataDir=%s', pid, resolvedDir);
  return { dataDir: resolvedDir };
}

export function registerQqScreenRoutes(app: Hono, deps: QqScreenRouteDependencies): void {
  // 截图端点轮询频率由前端控制（页面离开即停止），后端无状态无缓存——
  // 二维码必须实时，任何复用帧都可能误导扫码。display 参数用于切换实例屏幕。
  app.get('/api/qq/login-screen', async (c) => {
    const rawDisplay = c.req.query('display');
    let display = DISPLAY;
    if (rawDisplay != null && rawDisplay !== '') {
      const num = Number(rawDisplay);
      if (!Number.isInteger(num) || num < 0 || num > 65_535) {
        return c.json({ message: '非法的 display 参数' }, 400);
      }
      display = `:${num}`;
    }
    try {
      const png = await captureScreenPng(display);
      return c.body(new Uint8Array(png), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('login-screen capture failed: %s', message);
      return c.json({ message: `截图失败：${message}` }, 503);
    }
  });

  app.get('/api/qq/instances', async (c) => {
    const live = findQqMainProcesses();
    let hookList: Awaited<ReturnType<HookManager['listProcesses']>> = [];
    if (deps.hookManager) {
      try {
        hookList = await deps.hookManager.listProcesses();
      } catch (err) {
        log.warn('listProcesses failed: %s', err instanceof Error ? err.message : String(err));
      }
    }
    const byPid = new Map(hookList.map((p) => [p.pid, p]));
    const instances: QqInstanceStatus[] = live.map((p) => {
      const hook = byPid.get(p.pid);
      const registry = p.dataDir ? readInstanceRegistry(p.dataDir) : null;
      return {
        pid: p.pid,
        dataDir: p.dataDir,
        source: p.source,
        display: p.display ?? registry?.display ?? null,
        noVncPort: p.source === 'isolated' ? registry?.noVncPort ?? null : DEFAULT_NOVNC_PORT,
        injected: hook?.injected ?? false,
        loggedIn: hook?.loggedIn ?? false,
        status: hook?.status ?? 'unknown',
        uin: hook?.uin ?? '',
      };
    });
    return c.json({ instances });
  });

  app.post('/api/qq/relaunch', async (c) => {
    const live = findQqMainProcesses();
    if (live.length === 0) {
      return c.json({ success: false, terminated: [], message: '当前没有运行中的 QQ 进程' }, 404);
    }
    // 只重启未登录的实例——已登录实例被杀会直接掉线，这不是本操作的本意。
    let targets = live;
    if (deps.hookManager) {
      try {
        const hookList = await deps.hookManager.listProcesses();
        const loggedIn = new Set(hookList.filter((p) => p.loggedIn).map((p) => p.pid));
        const pending = live.filter((p) => !loggedIn.has(p.pid));
        if (pending.length > 0) targets = pending;
      } catch (err) {
        log.warn('relaunch hook lookup failed, falling back to all processes: %s',
          err instanceof Error ? err.message : String(err));
      }
    }
    const terminated: number[] = [];
    for (const target of targets) {
      if (terminateQqProcesses([target.pid], 'SIGTERM').length === 0) continue;
      terminated.push(target.pid);
      if (target.source === 'isolated' && target.dataDir) {
        // 隔离实例无人托管：等待退出后在其专属显示器上原位重启 QQ。
        const registry = readInstanceRegistry(target.dataDir);
        const display = registry?.display ?? target.display;
        if (display != null && await waitForExit(target.pid, TERM_GRACE_MS)) {
          const newPid = launchQqOnDisplay(target.dataDir, display);
          log.info('relaunched isolated instance pid=%d -> %d on :%d', target.pid, newPid, display);
        }
      }
    }
    log.info('relaunch terminated %d of %d qq process(es)', terminated.length, live.length);
    return c.json({
      success: terminated.length > 0,
      terminated,
      message: '已发送重启信号，新二维码将在数秒内出现',
    });
  });

  app.post('/api/qq/launch', async (c) => {
    const live = findQqMainProcesses();
    const isolatedCount = live.filter((p) => p.source === 'isolated').length;
    if (isolatedCount >= MAX_LAUNCHED_INSTANCES) {
      return c.json({
        success: false,
        message: `隔离实例已达上限（${MAX_LAUNCHED_INSTANCES} 个），请先在实例列表中确认不再使用的实例`,
      }, 400);
    }
    try {
      const dataDir = nextInstanceDir(live);
      const result = launchIsolatedInstance(dataDir);
      return c.json({ success: true, pid: result.pid, dataDir, display: result.display, noVncPort: result.noVncPort });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('launch failed: %s', message);
      return c.json({ success: false, message: `启动失败：${message}` }, 500);
    }
  });

  // 预检：截屏工具缺失时给出明确提示而不是让前端猜。
  app.get('/api/qq/screen-capable', (c) => {
    const xwd = existsSync('/usr/bin/xwd');
    const netpbm = existsSync('/usr/bin/pnmtopng');
    return c.json({
      capable: xwd && netpbm, xwd, netpbm, display: DISPLAY,
      defaultNoVncPort: DEFAULT_NOVNC_PORT,
    });
  });

  // 删除隔离实例：终止进程与其专属屏幕进程并清除数据目录（登录态一并清除）。
  app.delete('/api/qq/instances/:pid', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID_LIMIT) {
      return c.json({ success: false, message: 'invalid pid' }, 400);
    }
    try {
      const result = await removeQqInstance(pid);
      return c.json({ success: true, pid, dataDir: result.dataDir });
    } catch (err) {
      if (err instanceof QqInstanceError) {
        return c.json({ success: false, message: err.message }, err.status as 400);
      }
      log.error('remove instance pid=%d failed: %s', pid, err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '删除失败，请检查服务器日志' }, 500);
    }
  });
}
