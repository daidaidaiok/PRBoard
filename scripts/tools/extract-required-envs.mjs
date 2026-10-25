#!/usr/bin/env node
/**
 * 从 `.env.example` 抽取 required env key 集合，与外部实际配置的 key 做差集。PRboard 的 required env 真源是 `.env.example`
 * （docs/SETUP.md 口径：复制成 .env.local 并填上真实值），不像同类项目那样
 * 能从 lib/env.ts 的 .min(1) 标记推导——解析口径由此对齐 SETUP.md。
 *
 * 用法：node scripts/tools/extract-required-envs.mjs   # 每行一个 key，排序去重
 *
 * 结构说明：解析逻辑导出为 `parseRequiredEnvKeys` 供单测复用；仅直接执行本
 * 文件时才走 CLI 分支。
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseRequiredEnvKeys(text) {
  return [...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0].trim())
      .filter(Boolean),
  )].sort();
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const text = readFileSync(`${repoRoot}/.env.example`, "utf8");
  for (const key of parseRequiredEnvKeys(text)) console.log(key);
}
