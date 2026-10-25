"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface NotificationSettingsResponse {
  barkUrlMasked: string | null;
  hasBarkUrl: boolean;
  notifyCiGreen: boolean;
  notifyRetryExhausted: boolean;
  notifyPrConflict: boolean;
  notifyDeployFailed: boolean;
}

const SWITCH_ITEMS = [
  { key: "notifyCiGreen", label: "CI 全绿", description: "PR 关联的所有检查通过时推送" },
  { key: "notifyRetryExhausted", label: "CI 重试耗尽", description: "自动重试次数用完仍失败时推送" },
  { key: "notifyPrConflict", label: "PR 冲突", description: "PR 与目标分支产生冲突时推送" },
  { key: "notifyDeployFailed", label: "Vercel 部署失败", description: "Vercel 部署检查失败时推送" },
] as const;

type SwitchKey = (typeof SWITCH_ITEMS)[number]["key"];

export function NotificationSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [barkUrlInput, setBarkUrlInput] = useState("");
  const [saved, setSaved] = useState<NotificationSettingsResponse | null>(null);
  const [switches, setSwitches] = useState<Record<SwitchKey, boolean>>({
    notifyCiGreen: true,
    notifyRetryExhausted: true,
    notifyPrConflict: true,
    notifyDeployFailed: true,
  });

  useEffect(() => {
    fetch("/api/settings/notifications")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: NotificationSettingsResponse) => {
        setSaved(data);
        setSwitches({
          notifyCiGreen: data.notifyCiGreen,
          notifyRetryExhausted: data.notifyRetryExhausted,
          notifyPrConflict: data.notifyPrConflict,
          notifyDeployFailed: data.notifyDeployFailed,
        });
      })
      .catch(() => toast.error("加载通知设置失败"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // 输入框留空 + 已有配置 = 不改动 URL；主动清除走"清除"路径（清空后点"保存地址"）
        body: JSON.stringify({ ...switches }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "保存失败" }));
        throw new Error(error);
      }
      const data: NotificationSettingsResponse = await res.json();
      setSaved(data);
      toast.success("通知设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveBarkUrl() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barkUrl: barkUrlInput.trim() === "" ? null : barkUrlInput.trim() }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "保存失败" }));
        throw new Error(error);
      }
      const data: NotificationSettingsResponse = await res.json();
      setSaved(data);
      setBarkUrlInput("");
      toast.success(data.hasBarkUrl ? "Bark 推送地址已保存" : "Bark 推送地址已清除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/settings/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(barkUrlInput.trim() === "" ? {} : { barkUrl: barkUrlInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast.success("测试推送已发送，请查看手机");
      } else if (res.ok) {
        toast.error(`Bark 服务器拒绝了推送${data.status ? `（HTTP ${data.status}）` : ""}`);
      } else {
        toast.error(data.error === "no barkUrl configured" ? "请先填写并保存 Bark 推送地址" : "测试推送失败");
      }
    } catch {
      toast.error("测试推送失败");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知设置</CardTitle>
        <CardDescription>
          配置 Bark 推送（<a className="underline" href="https://bark.day.app" target="_blank" rel="noreferrer">bark.day.app</a>
          ，iOS App，支持自托管服务器）。在 Bark App 中复制推送 URL 粘贴到下方。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="bark-url" className="text-sm font-medium">
            Bark 推送地址
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="bark-url"
              type="url"
              placeholder={saved?.hasBarkUrl ? `已配置：${saved.barkUrlMasked ?? ""}` : "https://api.day.app/你的 device key"}
              value={barkUrlInput}
              onChange={(event) => setBarkUrlInput(event.target.value)}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleSaveBarkUrl} disabled={saving}>
                保存地址
              </Button>
              <Button type="button" variant="secondary" onClick={handleTest} disabled={testing}>
                发送测试推送
              </Button>
            </div>
          </div>
          {saved?.hasBarkUrl ? (
            <p className="text-xs text-muted-foreground">当前已配置（{saved.barkUrlMasked}）。填写新地址保存即可替换；如需清除，清空输入框后点&ldquo;保存地址&rdquo;。</p>
          ) : (
            <p className="text-xs text-muted-foreground">尚未配置。不配置则不会推送任何通知。</p>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          {SWITCH_ITEMS.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </div>
              <Switch
                checked={switches[item.key]}
                onCheckedChange={(checked) => setSwitches((prev) => ({ ...prev, [item.key]: Boolean(checked) }))}
                disabled={loading}
                aria-label={item.label}
              />
            </div>
          ))}
        </div>

        <Separator />

        <Button type="button" onClick={handleSave} disabled={saving || loading} className="w-fit">
          {saving ? "保存中…" : "保存通知开关"}
        </Button>
      </CardContent>
    </Card>
  );
}
