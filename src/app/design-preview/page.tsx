import type { Metadata } from "next";
import { DesignPreview } from "@/components/design-preview";

export const metadata: Metadata = {
  title: "设计预览 · PRboard",
  description: "iOS 毛玻璃风格与底部项目切换方案预览（不接真实数据）",
  robots: { index: false, follow: false },
};

export default function DesignPreviewPage() {
  return <DesignPreview />;
}
