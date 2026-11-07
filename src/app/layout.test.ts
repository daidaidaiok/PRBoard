import { describe, expect, it, vi } from "vitest";

// next/font/google 的加载器在 vitest node 环境不可执行，只保留导出的 variable 语义。
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--mock-geist-sans" }),
  Geist_Mono: () => ({ variable: "--mock-geist-mono" }),
}));

import { metadata, viewport } from "./layout";

// iOS/iPadOS「添加到主屏幕」安装链路的关键字段：
// 缺 apple-touch-icon 时 Safari 用网页截图当图标，缺 capable 时退化为浏览器标签页。
describe("root layout metadata (iOS PWA install chain)", () => {
  it("declares an apple-touch-icon so the home screen icon is the app icon", () => {
    // icons 的类型是 IconURL | Icon[] | Icons 联合，用 toMatchObject 同时完成收窄与断言
    expect(metadata.icons).toMatchObject({ apple: "/apple-touch-icon.png" });
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
