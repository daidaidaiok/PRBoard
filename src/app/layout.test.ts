import { describe, expect, it, vi } from "vitest";

// next/font/google 的加载器在 vitest node 环境不可执行，只保留导出的 variable 语义。
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--mock-geist-sans" }),
  Geist_Mono: () => ({ variable: "--mock-geist-mono" }),
}));

import { metadata, viewport } from "./layout";

// iOS/iPadOS「添加到主屏幕」安装链路的关键字段：
// apple-touch-icon 由文件约定 src/app/apple-icon.png（全出血，generate-icons.mjs 生成）提供；
// 显式 export metadata.icons 会让 Next 16 抑制 icon.svg / apple-icon.png 的自动输出
// （PR#18 Bugbot 实测），所以这里锁死「不显式声明 icons」。
describe("root layout metadata (iOS PWA install chain)", () => {
  it("does not override file-based icons so icon.svg and apple-icon.png stay in the head", () => {
    expect(metadata.icons).toBeUndefined();
  });

  it("opts into standalone web-app mode with the correct title", () => {
    // appleWebApp 的类型是 boolean | AppleWebApp，用 toMatchObject 同时完成收窄与断言
    expect(metadata.appleWebApp).toMatchObject({
      capable: true,
      title: "PRboard",
    });
  });

  it("keeps a device-width viewport so the standalone window scales correctly", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
