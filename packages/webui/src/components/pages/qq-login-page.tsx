import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, ExternalLink, Loader2, PlusCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { QqInstance } from '@/types';

const SCREEN_POLL_MS = 2_000;
const INSTANCES_POLL_MS = 5_000;

const STATUS_LABEL: Record<string, string> = {
  available: '可加载',
  loading: '加载中',
  connecting: '等待连接',
  loaded: '等待登录',
  online: '已在线',
  error: '错误',
  disconnected: '已断开',
  unknown: '未接入',
};

function statusBadgeVariant(status: string) {
  if (status === 'online') return 'success' as const;
  if (status === 'error' || status === 'disconnected') return 'destructive' as const;
  if (status === 'loading' || status === 'connecting' || status === 'loaded') return 'default' as const;
  return 'secondary' as const;
}

function noVncUrl(port: number): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol}//${window.location.hostname}:${port}/vnc.html`;
}

/**
 * QQ 登录面板：展示选中实例专属虚拟屏幕的实时截图（含登录二维码），并提供
 * 「重启登录窗口」（出新二维码）与「新增 QQ 进程」（独立屏幕 + HOME 隔离，
 * 由 SnowLuma 自动发现并注入）操作。点击实例卡片切换取景屏幕；
 * 密码登录兜底走各实例自己的 noVNC 页面。
 */
export function QqLoginPage() {
  const api = useApi();

  // ---- 实时截图（blob → object URL，轮询期间复用同一 target 引用防泄漏） ----
  const urlTargetRef = useRef<{ url: string | null }>({ url: null });
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [capability, setCapability] = useState<{ capable: boolean; display: string } | null>(null);

  // ---- 实例列表与选中态（点击卡片切换截图取景屏幕） ----
  const [instances, setInstances] = useState<QqInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [activePid, setActivePid] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState<'relaunch' | 'launch' | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busyPids, setBusyPids] = useState<Set<number>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<QqInstance | null>(null);

  const activeInstance = instances.find((i) => i.pid === activePid) ?? null;
  // 选中的实例已登录后其屏幕不再变化（登录窗口消失），停帧省开销。
  const pollScreen = capability?.capable !== false
    && activeInstance != null
    && !activeInstance.loggedIn;

  const refreshScreen = useCallback(async (display: number | null, signal?: AbortSignal) => {
    try {
      const url = await api.qqLogin.screen(urlTargetRef.current, display, signal);
      setScreenUrl(url);
      setScreenError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (signal?.aborted) return;
      setScreenError(err instanceof Error ? err.message : '截图失败');
    }
  }, [api]);

  const refreshInstances = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api.qqLogin.instances();
      if (!signal?.aborted) setInstances(list);
    } catch (err) {
      console.error('qq instances', err);
    } finally {
      if (!signal?.aborted) setInstancesLoading(false);
    }
  }, [api]);

  // 能力预检：截屏工具缺失时直接给出结论，避免页面空转。
  useEffect(() => {
    let cancelled = false;
    api.qqLogin.screenCapable()
      .then((cap) => { if (!cancelled) setCapability({ capable: cap.capable, display: cap.display }); })
      .catch(() => { if (!cancelled) setCapability({ capable: false, display: ':99' }); });
    return () => { cancelled = true; };
  }, [api]);

  // 默认选中第一个实例；选中项消失（被删除/退出）时回落到列表首个。
  useEffect(() => {
    if (instances.length === 0) {
      if (activePid != null) setActivePid(null);
      return;
    }
    if (activePid == null || !instances.some((i) => i.pid === activePid)) {
      setActivePid(instances[0].pid);
    }
  }, [instances, activePid]);

  // 截图轮询：跟随选中实例的显示器；卸载/停轮询时中断请求并释放 object URL。
  const activeDisplay = activeInstance?.display ?? null;
  useEffect(() => {
    if (!pollScreen || activePid == null) return;
    const controller = new AbortController();
    void refreshScreen(activeDisplay, controller.signal);
    const timer = setInterval(() => void refreshScreen(activeDisplay, controller.signal), SCREEN_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      if (urlTargetRef.current.url) {
        URL.revokeObjectURL(urlTargetRef.current.url);
        urlTargetRef.current.url = null;
      }
    };
    // activeDisplay 变化（切换卡片）必须重建轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollScreen, activePid, activeDisplay, refreshScreen]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshInstances(controller.signal);
    const timer = setInterval(() => void refreshInstances(controller.signal), INSTANCES_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshInstances]);

  const relaunch = async () => {
    setActionBusy('relaunch');
    setActionMessage(null);
    try {
      const result = await api.qqLogin.relaunch();
      setActionMessage(result.success
        ? { tone: 'success', text: `已重启 ${result.terminated.length} 个登录窗口，新二维码将在数秒内出现` }
        : { tone: 'error', text: result.message ?? '重启失败' });
      void refreshInstances();
    } catch (err) {
      setActionMessage({ tone: 'error', text: err instanceof Error ? err.message : '重启失败' });
    } finally {
      setActionBusy(null);
    }
  };

  const launch = async () => {
    setActionBusy('launch');
    setActionMessage(null);
    try {
      const result = await api.qqLogin.launch();
      if (result.success) {
        setActionMessage({
          tone: 'success',
          text: `已启动新 QQ 实例（PID ${result.pid}，屏幕 :${result.display ?? '?'}，noVNC ${result.noVncPort ?? '?'}），等待自动注入后扫码登录`,
        });
        // 新实例通常 PID 最大，直接切换过去扫码最顺手。
        if (result.pid != null) setActivePid(result.pid);
      } else {
        setActionMessage({ tone: 'error', text: result.message ?? '启动失败' });
      }
      void refreshInstances();
    } catch (err) {
      setActionMessage({ tone: 'error', text: err instanceof Error ? err.message : '启动失败' });
    } finally {
      setActionBusy(null);
    }
  };

  /** 单实例刷新：重新触发该进程的注入管道刷新。 */
  const refreshInstance = async (pid: number) => {
    setBusyPids((prev) => new Set(prev).add(pid));
    setActionMessage(null);
    try {
      await api.processes.refresh(pid);
      setActionMessage({ tone: 'success', text: `已刷新实例 PID ${pid} 的注入状态` });
      void refreshInstances();
    } catch (err) {
      setActionMessage({ tone: 'error', text: err instanceof Error ? err.message : `刷新 PID ${pid} 失败` });
    } finally {
      setBusyPids((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  };

  /** 删除隔离实例：终止进程、回收其专属屏幕并清除数据目录（登录态一并清除）。 */
  const removeInstance = async (pid: number) => {
    setBusyPids((prev) => new Set(prev).add(pid));
    setActionMessage(null);
    try {
      const result = await api.qqLogin.removeInstance(pid);
      setActionMessage({ tone: 'success', text: `实例 PID ${pid} 已删除，数据目录 ${result.dataDir ?? ''} 已清除` });
      void refreshInstances();
    } catch (err) {
      setActionMessage({ tone: 'error', text: err instanceof Error ? err.message : `删除 PID ${pid} 失败` });
    } finally {
      setBusyPids((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
      setConfirmRemove(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div className="min-w-0">
            <CardTitle>QQ 登录</CardTitle>
            <CardDescription>
              每个实例拥有独立屏幕，点击实例卡片切换画面；用手机 QQ 扫描二维码即可登录
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={relaunch}
              disabled={actionBusy != null}
            >
              {actionBusy === 'relaunch'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RefreshCw className="size-3.5" />} 重启登录窗口
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={launch}
              disabled={actionBusy != null}
            >
              {actionBusy === 'launch'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <PlusCircle className="size-3.5" />} 新增 QQ 进程
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {actionMessage && (
            <div
              role="status"
              className={cn(
                'mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
                actionMessage.tone === 'success'
                  ? 'border-primary/20 bg-primary/[0.06] text-primary'
                  : 'border-destructive/30 bg-destructive/10 text-destructive',
              )}
            >
              <AlertCircle className="size-3.5 shrink-0" />
              {actionMessage.text}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* 截图卡片：跟随选中实例的屏幕 */}
            <div className="flex flex-col gap-3">
              <div className="relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-xl border bg-black">
                {screenUrl && (
                  <img
                    src={screenUrl}
                    alt={activeInstance ? `实例 PID ${activeInstance.pid} 屏幕画面` : 'QQ 登录窗口实时画面'}
                    className="max-h-[560px] w-auto max-w-full object-contain"
                  />
                )}
                {!screenUrl && !screenError && (
                  <div className="flex flex-col items-center gap-2 text-neutral-500">
                    <Loader2 className="size-6 animate-spin" />
                    <p className="text-xs">
                      {activeInstance ? `正在截取实例 PID ${activeInstance.pid} 的屏幕…` : '正在截取虚拟屏幕…'}
                    </p>
                  </div>
                )}
                {screenError && (
                  <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-neutral-400">
                    <AlertCircle className="size-8 opacity-70" strokeWidth={1.5} />
                    <p className="text-sm">{screenError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setScreenError(null); void refreshScreen(activeDisplay); }}
                    >
                      <RefreshCw className="size-3.5" /> 重试
                    </Button>
                  </div>
                )}
                {pollScreen && screenUrl && (
                  <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-emerald-400 backdrop-blur">
                    <Camera className="size-3" /> 实时 :{activeDisplay ?? '?'}
                  </span>
                )}
                {activeInstance?.loggedIn && (
                  <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-neutral-300 backdrop-blur">
                    该实例已登录，已停止刷新
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {capability
                    ? capability.capable
                      ? `当前取景 ${activeDisplay != null ? `:${activeDisplay}` : capability.display}`
                      : '服务端缺少截屏组件（xwd / netpbm），请更新镜像'
                    : '检测截屏能力中…'}
                </span>
                {lastUpdated && <span>最后刷新 {lastUpdated.toLocaleTimeString()}</span>}
              </div>
            </div>

            {/* 实例列表：点击卡片切换屏幕取景 */}
            <Card className="self-start">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">QQ 实例</CardTitle>
                <CardDescription>点击卡片切换屏幕画面</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {instancesLoading && instances.length === 0 && (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 加载中…
                  </div>
                )}
                {!instancesLoading && instances.length === 0 && (
                  <p className="py-6 text-sm text-muted-foreground">未检测到运行中的 QQ 进程</p>
                )}
                {instances.map((instance) => {
                  const selected = instance.pid === activePid;
                  return (
                    <div
                      key={instance.pid}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActivePid(instance.pid)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActivePid(instance.pid); }}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                        selected
                          ? 'border-primary/40 bg-primary/[0.06]'
                          : 'border-border bg-card/50 hover:bg-accent/40',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">QQ</span>
                          <Badge variant={statusBadgeVariant(instance.status)}>
                            {STATUS_LABEL[instance.status] ?? instance.status}
                          </Badge>
                          {instance.source === 'isolated' && (
                            <Badge variant="outline">隔离实例</Badge>
                          )}
                          {instance.display != null && (
                            <span className="text-xs text-muted-foreground">:{instance.display}</span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          PID {instance.pid}
                          {instance.loggedIn && instance.uin ? ` · ${instance.uin}` : ''}
                          {instance.dataDir ? ` · ${instance.dataDir}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {instance.noVncPort != null && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={`密码登录（noVNC :${instance.noVncPort}）`}
                            asChild
                          >
                            <a href={noVncUrl(instance.noVncPort)} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        )}
                        {instance.injected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="刷新该实例的注入状态"
                            disabled={busyPids.has(instance.pid)}
                            onClick={() => void refreshInstance(instance.pid)}
                          >
                            {busyPids.has(instance.pid)
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <RefreshCw className="size-3.5" />}
                          </Button>
                        )}
                        {instance.source === 'isolated' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="终止进程、回收屏幕并删除该实例的数据目录"
                            disabled={busyPids.has(instance.pid)}
                            className="text-destructive hover:text-destructive"
                            onClick={() => setConfirmRemove(instance)}
                          >
                            {busyPids.has(instance.pid)
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <Trash2 className="size-3.5" />}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  新增实例会获得独立屏幕（显示器 :100 起）并被自动注入；各实例的 noVNC 入口在卡片上
                  （外部链接图标）。删除仅对隔离实例开放，将终止进程、回收屏幕并清除其登录数据。
                </p>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title="确认删除该 QQ 实例？"
        description={confirmRemove
          ? `将终止进程 ${confirmRemove.pid}、回收其屏幕（:${confirmRemove.display ?? '?'}）并删除数据目录 ${confirmRemove.dataDir ?? ''}，该实例的登录态与本地数据将一并清除，且不可恢复。`
          : ''}
        confirmText="删除"
        destructive
        onConfirm={() => { if (confirmRemove) void removeInstance(confirmRemove.pid); }}
      />
    </div>
  );
}
