import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-guard";
import { AppHeader } from "@/components/app-header";
import { NotificationSettings } from "@/components/notification-settings";
import { ArrowLeft } from "lucide-react";

export default async function NotificationSettingsPage() {
  const session = await requireSession();
  if (!session) redirect("/login");
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader user={session.user} />
      <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
        <Link href="/" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          返回 PR 看板
        </Link>
        <div className="mx-auto w-full max-w-2xl">
          <NotificationSettings />
        </div>
      </main>
    </div>
  );
}
