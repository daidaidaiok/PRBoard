"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetch-with-timeout";
import { mib, percentage } from "@/lib/host-capacity";
import { parseRealtimeEvent, shouldRefreshOnHostEvent } from "@/lib/realtime-events";

// Fallback only — the SSE subscription below refreshes on host-metrics events.
// The long poll just covers the gap while that connection is down, and the
// shared 90s throttle window keeps the two triggers from stacking: host
// telemetry can change at most every ingest interval, so refreshing more
// often than that only burns egress.
const POLL_INTERVAL_MS = 300_000;
const SSE_MIN_REFRESH_MS = 90_000;

type Platform = "macos" | "windows" | "linux";
type CapacityRole = "primary" | "shared";
type RecommendationKind = "collecting" | "hold" | "headroom-without-demand" | "add-canary";

interface Metric {
  capturedAt: string;
  cpuUsageBasisPoints: number;
  logicalCpuCores: number;
  memoryTotalMib: number;
  memoryUsedMib: number;
  diskTotalMib: number;
  diskUsedMib: number;
  swapTotalMib: number;
  swapUsedMib: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  runnerListenerCount: number;
  runnerWorkerCount: number;
  load1: number | null;
}

interface HourlyMetric {
  capturedAt: string;
  cpuUsageBasisPoints: number;
  memoryUsageBasisPoints: number;
  diskUsageBasisPoints: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  runnerBusy: boolean;
}

interface MonitorHost {
  id: string;
  displayName: string;
  platform: Platform;
  capacityDomain: string;
  capacityRole: CapacityRole;
  runnerName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  runnerCpuReserveMilliCores: number;
  runnerMemoryReserveMib: number;
}

interface CapacityDomain {
  capacityDomain: string;
  capacitySourceHostId: string | null;
  cpuP95BasisPoints: number;
  memoryP95BasisPoints: number;
  diskMaxBasisPoints: number;
  swapP95BasisPoints: number;
  runnerBusyBasisPoints: number;
  dataCoverageBasisPoints: number;
  recommendation: { kind: RecommendationKind; additionalRunners: number; reason: string };
  hosts: Array<{ host: MonitorHost; latestMetric: Metric | null; sampleCount: number; stale: boolean; hourly: HourlyMetric[] }>;
}

interface Enrollment {
  host: Pick<MonitorHost, "id" | "displayName" | "platform">;
  token: string;
  baseUrl: string;
}

const initialForm = {
  displayName: "",
  platform: "macos" as Platform,
  capacityDomain: "",
  capacityRole: "primary" as CapacityRole,
  runnerName: "",
  runnerCpuReserveMilliCores: "2000",
  runnerMemoryReserveMib: "4096",
};

function bytesPerSecond(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB/s`;
  return `${value} B/s`;
}

function platformLabel(platform: Platform): string {
  return platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux / WSL";
}

function recommendationLabel(kind: RecommendationKind): string {
  switch (kind) {
    case "add-canary": return "可增加 canary Runner";
    case "headroom-without-demand": return "有余量，暂无需求";
    case "hold": return "保持当前规模";
    default: return "采集数据中";
  }
}

function recommendationVariant(kind: RecommendationKind): "default" | "secondary" | "outline" | "destructive" {
  if (kind === "add-canary") return "default";
  if (kind === "hold") return "destructive";
  if (kind === "collecting") return "secondary";
  return "outline";
}

function linePoints(points: HourlyMetric[], selector: (point: HourlyMetric) => number): string {
  if (points.length === 0) return "";
  const width = 240;
  const height = 52;
  return points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - Math.min(10_000, Math.max(0, selector(point))) / 10_000 * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function Sparkline({ points, hostName }: { points: HourlyMetric[]; hostName: string }) {
  if (points.length === 0) return <p className="text-xs text-muted-foreground">尚无 24 小时趋势数据。</p>;
  return (
    <div className="flex flex-col gap-1">
      <svg viewBox="0 0 240 52" role="img" aria-label={`${hostName} 最近 24 小时 CPU 与内存利用率趋势`} className="h-16 w-full overflow-visible">
        <line x1="0" x2="240" y1="26" y2="26" className="stroke-border" strokeDasharray="3 3" />
        <polyline points={linePoints(points, (point) => point.memoryUsageBasisPoints)} fill="none" className="stroke-violet-500" strokeWidth="2" />
        <polyline points={linePoints(points, (point) => point.cpuUsageBasisPoints)} fill="none" className="stroke-sky-500" strokeWidth="2" />
      </svg>
      <div className="flex gap-3 text-xs text-muted-foreground"><span className="text-sky-500">— CPU</span><span className="text-violet-500">— 内存</span><span>{points.length} 个小时点</span></div>
    </div>
  );
}

function MetricTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-lg bg-muted/50 p-2.5"><div className="flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</div><strong className="mt-1 block tabular-nums">{value}</strong></div>;
}

export function HostCapacityMonitor() {
  const [domains, setDomains] = useState<CapacityDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  // Shared by the poll and the SSE listener below: timestamp of the last
  // successful /api/hosts fetch, 0 meaning "never fetched yet".
  const lastRefreshAt = useRef(0);

  const loadHosts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await fetchWithTimeout("/api/hosts", { cache: "no-store" });
      const data = (await response.json()) as { domains?: CapacityDomain[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "加载主机容量失败");
      setDomains(data.domains ?? []);
      // Only successful fetches advance the throttle window, so a failure
      // never suppresses the next SSE- or poll-triggered attempt.
      lastRefreshAt.current = Date.now();
      setError(null);
    } catch (loadError) {
      setError(isTimeoutError(loadError) ? "请求超时，网络或服务响应缓慢" : loadError instanceof Error ? loadError.message : "加载主机容量失败");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // This component synchronizes with the independent host telemetry API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHosts(true);
    const timer = setInterval(() => {
      // Defensive: an SSE event may have just refreshed — stay inside the
      // shared throttle window instead of stacking a poll on top of it.
      if (Date.now() - lastRefreshAt.current < SSE_MIN_REFRESH_MS) return;
      void loadHosts(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadHosts]);

  // Real-time push: host ingest -> Postgres NOTIFY -> this SSE stream ->
  // throttled refetch. The fixed 300s poll above stays as a fallback for a
  // dropped connection; EventSource reconnects on its own, so errors are
  // left to it silently. Non-host events (reason !== "host-metrics") are
  // ignored here — they drive the PR board, not host telemetry.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("update", (event: MessageEvent) => {
      const payload = parseRealtimeEvent(typeof event.data === "string" ? event.data : "");
      if (!payload || !shouldRefreshOnHostEvent(payload, lastRefreshAt.current, Date.now(), SSE_MIN_REFRESH_MS)) return;
      lastRefreshAt.current = Date.now();
      void loadHosts(true);
    });
    return () => source.close();
  }, [loadHosts]);

  const summary = useMemo(() => {
    const hosts = domains?.flatMap((domain) => domain.hosts) ?? [];
    return {
      total: hosts.length,
      reporting: hosts.filter((item) => !item.stale).length,
      stale: hosts.filter((item) => item.stale).length,
      canary: domains?.filter((domain) => domain.recommendation.kind === "add-canary").length ?? 0,
    };
  }, [domains]);

  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch("/api/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.displayName,
          platform: form.platform,
          capacityDomain: form.capacityDomain,
          capacityRole: form.capacityRole,
          runnerName: form.runnerName.trim() || null,
          runnerCpuReserveMilliCores: Number(form.runnerCpuReserveMilliCores),
          runnerMemoryReserveMib: Number(form.runnerMemoryReserveMib),
        }),
      });
      const data = (await response.json()) as { host?: Enrollment["host"]; token?: string; error?: string };
      if (!response.ok || !data.host || !data.token) throw new Error(data.error ?? "创建主机失败");
      setEnrollment({ host: data.host, token: data.token, baseUrl: window.location.origin });
      setForm(initialForm);
      await loadHosts(true);
      toast.success("主机已登记，请立即保存一次性 token");
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "创建主机失败");
    } finally {
      setSaving(false);
    }
  }

  async function removeHost(host: MonitorHost) {
    if (!window.confirm(`移除 ${host.displayName} 会撤销它的 token 并删除历史样本。是否继续？`)) return;
    try {
      const response = await fetch(`/api/hosts?hostId=${encodeURIComponent(host.id)}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "移除主机失败");
      await loadHosts(true);
      toast.success(`已移除 ${host.displayName}`);
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : "移除主机失败");
    }
  }

  async function copyEnrollment() {
    if (!enrollment) return;
    const command = [
      `PRBOARD_URL=${JSON.stringify(enrollment.baseUrl)}`,
      `PRBOARD_HOST_ID=${JSON.stringify(enrollment.host.id)}`,
      `PRBOARD_HOST_TOKEN=${JSON.stringify(enrollment.token)}`,
      "PRBOARD_INTERVAL_SECONDS=60",
      "npm run host:monitor",
    ].join(" ");
    try {
      await navigator.clipboard.writeText(command);
      toast.success("启动命令已复制；token 只会显示这一次");
    } catch {
      toast.error("复制失败，请手动保存 token");
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="host-capacity-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="host-capacity-title" className="flex items-center gap-2 text-xl font-semibold"><Server className="size-5" />主机性能与容量</h2>
          <p className="text-sm text-muted-foreground">Mac、Windows 与 WSL/Linux 的主机资源、Runner Worker 负载和保守扩容建议。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => loadHosts()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />刷新</Button>
          <Button size="sm" onClick={() => { setEnrollment(null); setFormError(null); setDialogOpen(true); }}><Plus className="size-3.5" />新增主机</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["全部主机", summary.total], ["正在上报", summary.reporting], ["遥测过期", summary.stale], ["可试 canary", summary.canary]].map(([label, count]) => (
          <Card key={label as string} size="sm"><CardContent className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span><strong className="text-lg tabular-nums">{count}</strong></CardContent></Card>
        ))}
      </div>

      {error && <Card className="border-destructive/50"><CardContent className="flex items-center gap-2 text-sm text-destructive"><CircleAlert className="size-4" />主机容量加载失败：{error}</CardContent></Card>}
      {domains !== null && domains.length === 0 && !error && <Card><CardContent className="text-sm text-muted-foreground">尚未登记主机。先新增 Mac、Windows 或 WSL/Linux 主机，再在对应机器上启动采集器。</CardContent></Card>}

      <div className="flex flex-col gap-3">
        {domains?.map((domain) => {
          const source = domain.hosts.find((item) => item.host.id === domain.capacitySourceHostId);
          return (
            <Card key={domain.capacityDomain}>
              <CardHeader className="gap-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div><CardTitle>容量域：{domain.capacityDomain}</CardTitle><CardDescription>{source ? `主容量来源：${source.host.displayName}` : "尚未指定主容量来源"}</CardDescription></div>
                  <Badge variant={recommendationVariant(domain.recommendation.kind)}>{recommendationLabel(domain.recommendation.kind)}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{domain.recommendation.reason}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                  <MetricTile icon={<Cpu className="size-3" />} label="CPU p95" value={percentage(domain.cpuP95BasisPoints)} />
                  <MetricTile icon={<MemoryStick className="size-3" />} label="内存 p95" value={percentage(domain.memoryP95BasisPoints)} />
                  <MetricTile icon={<HardDrive className="size-3" />} label="磁盘最高" value={percentage(domain.diskMaxBasisPoints)} />
                  <MetricTile icon={<Activity className="size-3" />} label="Swap p95" value={percentage(domain.swapP95BasisPoints)} />
                  <MetricTile icon={<Activity className="size-3" />} label="Worker 忙碌" value={percentage(domain.runnerBusyBasisPoints)} />
                  <MetricTile icon={<CircleCheck className="size-3" />} label="数据覆盖" value={percentage(domain.dataCoverageBasisPoints)} />
                </div>
                {source && <Sparkline points={source.hourly} hostName={source.host.displayName} />}
                <div className="grid gap-2 lg:grid-cols-2">
                  {domain.hosts.map((item) => {
                    const latest = item.latestMetric;
                    return (
                      <div key={item.host.id} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div><div className="flex items-center gap-2 font-medium"><span className={`size-2 rounded-full ${item.stale ? "bg-zinc-400" : "bg-emerald-500"}`} />{item.host.displayName}</div><p className="mt-1 text-xs text-muted-foreground">{platformLabel(item.host.platform)} · {item.host.capacityRole === "primary" ? "主容量" : "共享 guest"}{item.host.runnerName ? ` · ${item.host.runnerName}` : ""}</p></div>
                          <div className="flex items-center gap-1"><Badge variant={item.stale ? "secondary" : "outline"}>{item.stale ? <CircleDashed className="size-3" /> : <CircleCheck className="size-3" />}{item.stale ? "遥测过期" : "正在上报"}</Badge><Button variant="ghost" size="icon-xs" aria-label={`移除 ${item.host.displayName}`} title="移除主机" onClick={() => removeHost(item.host)}><Trash2 className="size-3" /></Button></div>
                        </div>
                        {latest ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <MetricTile icon={<Cpu className="size-3" />} label="CPU" value={percentage(latest.cpuUsageBasisPoints)} />
                          <MetricTile icon={<MemoryStick className="size-3" />} label="内存" value={`${mib(latest.memoryUsedMib)} / ${mib(latest.memoryTotalMib)}`} />
                          <MetricTile icon={<HardDrive className="size-3" />} label="磁盘" value={`${mib(latest.diskUsedMib)} / ${mib(latest.diskTotalMib)}`} />
                          <MetricTile icon={<Network className="size-3" />} label="网络" value={`↓${bytesPerSecond(latest.networkRxBytesPerSecond)} ↑${bytesPerSecond(latest.networkTxBytesPerSecond)}`} />
                        </div> : <p className="text-sm text-muted-foreground">等待首个指标样本。</p>}
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>样本：{item.sampleCount}</span><span>Worker：{latest?.runnerWorkerCount ?? 0}/{latest?.runnerListenerCount ?? 0}</span>{latest?.load1 !== null && latest?.load1 !== undefined && <span>Load 1：{latest.load1.toFixed(2)}</span>}<span>心跳：{item.host.lastSeenAt ? new Date(item.host.lastSeenAt).toLocaleString("zh-CN") : "从未"}</span></div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEnrollment(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{enrollment ? "保存采集器 token" : "新增主机"}</DialogTitle><DialogDescription>{enrollment ? "此 token 只显示一次。保存后在对应主机运行采集器。" : "Windows 和 WSL 请使用同一容量域；Windows 选主容量，WSL 选共享 guest。"}</DialogDescription></DialogHeader>
          {enrollment ? <div className="flex flex-col gap-3"><div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><strong>{enrollment.host.displayName}</strong> 已登记。关闭这个窗口前复制并安全保存 token。</div><pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-5">{`PRBOARD_URL=${JSON.stringify(enrollment.baseUrl)}\nPRBOARD_HOST_ID=${JSON.stringify(enrollment.host.id)}\nPRBOARD_HOST_TOKEN=${JSON.stringify(enrollment.token)}\nPRBOARD_INTERVAL_SECONDS=60\nnpm run host:monitor`}</pre><DialogFooter><Button onClick={copyEnrollment}><Copy className="size-3.5" />复制启动命令</Button></DialogFooter></div> : <form className="flex flex-col gap-3" onSubmit={createHost}>
            <div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-1 text-sm font-medium">主机名称<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} className="h-9 rounded-md border bg-background px-3 text-sm" placeholder="Windows 工作站" /></label><label className="flex flex-col gap-1 text-sm font-medium">平台<select value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value as Platform })} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="macos">macOS</option><option value="windows">Windows</option><option value="linux">Linux / WSL</option></select></label></div>
            <div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-1 text-sm font-medium">容量域<input required value={form.capacityDomain} onChange={(event) => setForm({ ...form, capacityDomain: event.target.value })} className="h-9 rounded-md border bg-background px-3 text-sm" placeholder="windows-wsl" /></label><label className="flex flex-col gap-1 text-sm font-medium">容量角色<select value={form.capacityRole} onChange={(event) => setForm({ ...form, capacityRole: event.target.value as CapacityRole })} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="primary">主容量来源</option><option value="shared">共享 guest（如 WSL）</option></select></label></div>
            <label className="flex flex-col gap-1 text-sm font-medium">可选 GitHub Runner 名称<input value={form.runnerName} onChange={(event) => setForm({ ...form, runnerName: event.target.value })} className="h-9 rounded-md border bg-background px-3 text-sm" placeholder="windows-runner" /></label>
            <div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-1 text-sm font-medium">每 Runner CPU 预留（millicores）<input required type="number" min="250" value={form.runnerCpuReserveMilliCores} onChange={(event) => setForm({ ...form, runnerCpuReserveMilliCores: event.target.value })} className="h-9 rounded-md border bg-background px-3 text-sm" /></label><label className="flex flex-col gap-1 text-sm font-medium">每 Runner 内存预留（MiB）<input required type="number" min="512" value={form.runnerMemoryReserveMib} onChange={(event) => setForm({ ...form, runnerMemoryReserveMib: event.target.value })} className="h-9 rounded-md border bg-background px-3 text-sm" /></label></div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}<DialogFooter><Button type="submit" disabled={saving}>{saving && <RefreshCw className="size-3.5 animate-spin" />}创建并显示 token</Button></DialogFooter>
          </form>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
