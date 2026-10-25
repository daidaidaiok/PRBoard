import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>PRboard</CardTitle>
          <CardDescription>跨仓库 GitHub PR + CI 看板</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              "use server";
              await signIn("github-app", { redirectTo: "/" });
            }}
          >
            <Button type="submit" className="w-full">
              使用 GitHub 登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
