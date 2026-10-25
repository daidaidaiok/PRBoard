import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-guard";
import { AppHeader } from "@/components/app-header";
import { Dashboard } from "@/components/dashboard";
import { countInstallationsForUser } from "@/db/installations";

export default async function DashboardPage() {
  const session = await requireSession();
  if (!session) {
    redirect("/login");
  }

  // A DB hiccup here must not blank the whole page via the error boundary —
  // assume installed (the common case) and let the dashboard's own data
  // fetch surface the failure with its retry affordance.
  let hasInstallation = true;
  try {
    hasInstallation = (await countInstallationsForUser(session.user.userId)) > 0;
  } catch (error) {
    console.error("[page] failed to count installations", error);
  }

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader user={session.user} />

      <Dashboard hasInstallation={hasInstallation} userLogin={session.user.login} />
    </div>
  );
}
