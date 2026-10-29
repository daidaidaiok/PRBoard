import Image from "next/image";
import Link from "next/link";
import { signOut } from "@/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Activity, Bell } from "lucide-react";

export function AppHeader({ user }: { user: { login?: string | null; image?: string | null } }) {
  const login = user.login ?? "用户";
  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <div className="flex items-center gap-2">
        <Image src="/icons/icon-192.png" alt="" width={24} height={24} className="rounded-md" />
        <h1 className="text-lg font-semibold">PRboard</h1>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <Link
          href="/settings/notifications"
          aria-label="通知设置"
          title="通知设置"
          className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Bell className="size-4" />
        </Link>
        <Link
          href="/runners"
          aria-label="Runner 监控"
          title="Runner 监控"
          className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Activity className="size-4" />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar className="size-7">
              <AvatarImage src={user.image ?? undefined} alt={login} />
              <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{login}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}
              >
                退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <noscript>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <Button type="submit" variant="outline" size="sm">
              退出登录
            </Button>
          </form>
        </noscript>
      </div>
    </header>
  );
}
