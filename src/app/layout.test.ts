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
    expect(metadata.icons).toBeDefined();
    expect(metadata.icons?.apple).toBe("/apple-touch-icon.png");
  });

  it("opts into standalone web-app mode with the correct title", () => {
    expect(metadata.appleWebApp?.capable).toBe(true);
    expect(metadata.appleWebApp?.title).toBe("PRboard");
  });

  it("keeps a device-width viewport so the standalone window scales correctly", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
