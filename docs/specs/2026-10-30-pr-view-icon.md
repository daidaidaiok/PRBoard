# 单图标切换全部 PR 展示

将两个文字按钮合并为一个 icon-sm 按钮。备选为图标菜单，但会增加一次点击，不采用。
复用 Maximize2/Minimize2 与 Button；title 和 aria-label 显示下一步动作。
判断所有 displayPrs（包括隐藏项目），任意卡片展开时点击全部折叠；全折叠时点击全部展开。
仍使用 setAllCompact 清空逐卡覆盖；空列表/加载时禁用。仅 UI，不改持久化或 API。
