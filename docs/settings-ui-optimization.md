# Kun 设置界面优化方案

> 状态：草案 v0.2 — 目标校准版
> 范围：`src/renderer/src/components/settings-section-*.tsx`、`settings-controls.tsx`、`SettingsView.tsx`、相关 locales

## 0. 目标（产品视角）

> **提升用户体验，让用户能快速定位想设置的 item。**

展开成三条可验收的子目标：

1. **Find（已知名称）**：用户知道要找什么时，**3 秒内**能从入口到达对应 row
2. **Browse（探索浏览）**：用户没有具体目标时，能在 **2 屏内**看完一个分类
3. **Discover（识别回忆）**：用户记得"大概是 timeout 之类的"时，能**通过关键词**搜到目标

对应到具体动作优先级：

| 优先级 | 动作 | 目标 |
|---|---|---|
| P0 | 引入**搜索框 / 命令面板** | 覆盖 Find 场景（已知名称） |
| P0 | 抽出"运行时"为第一级卡，**释放**高频旋钮 | 覆盖 Browse 场景 |
| P1 | 重命名"两张高级卡"消除歧义 | 覆盖 Discover 场景 |
| P1 | 长卡片顶部加 **SectionJumpButton** | 辅助 Browse |
| P2 | "重置为默认值"按钮 | 安全感 |
| P2 | runtime 重启类设置加提示 | 减少踩坑 |

---

## 1. 现状盘点

### 1.1 AI Assistant 页面是 settings 的"重灾区"

`settings-section-agents.tsx`（1618 行）一张 page 同时承担了 8 个主题、4 层嵌套、50+ 个 SettingRow：

| # | SettingsCard 标题 | 行号 | 包含的 SettingRow | 嵌套 AdvancedSettingsDisclosure |
|---|---|---|---|---|
| 1 | AI 助手（基础） | `428` | 4 个 + 1 嵌套 | `490-573`（"Assistant advanced settings"，含 Local port / program path / data folder / access token） |
| 2 | 权限与审批 | `606` | 2 个 | — |
| 3 | Computer use | `648` | 2 个 | — |
| 4 | Design quality | `692` | 2 个 | — |
| 5 | 技能 | `727` | 3 个 | — |
| 6 | 外部工具（MCP） | `836` | 9 个 | `848-1013`（含 6 个额外 row） |
| 7 | **高级运行设置** | `1020` | 14 个 | `1022-1378`（"存储、模型上下文与工具保护"，**含 Stream idle timeout**） |
| 8 | Diagnostics（已配置能力快照）| `1384` | 5 个 | `1386-1526` |

> 注：第 8 张"Diagnostics"卡是 **settings 页面里展示已配置 runtime 能力快照**的卡，**不是**弹窗式 self-check UI，与 `docs/AGENTS.md` 禁止的 `RuntimeDiagnosticsDialog` / `ConnectionStatusBar` 不是一个东西。详见 §1.3。

**最深路径 = 4 层**：`SettingsCategory`（AI 助手）→ `SettingsCard`（高级运行设置）→ `AdvancedSettingsDisclosure`（存储、模型上下文与工具保护）→ `SettingRow`（流式空闲超时）。

> 实测：从侧边栏点 AI 助手到改完流式空闲超时，要滚 7 屏。

### 1.2 其他页面也有类似问题但更轻

- `settings-section-write.tsx`（700 行）— 2 个 AdvancedSettingsDisclosure，分别 6 / 8 行
- `settings-section-claw.tsx`（527 行）— 1 个 AdvancedSettingsDisclosure，6 行
- `settings-section-media-generation.tsx`（154 行）— 无嵌套
- `settings-section-providers.tsx`（454+ 行）— 无嵌套

Write / Claw / Media 的"高级"折叠没埋太深，主要病灶在 AI Assistant。

### 1.3 组件层的问题

`settings-controls.tsx:269-292` 的 `AdvancedSettingsDisclosure`：

```tsx
<details className="group overflow-hidden rounded-xl border ...">
  <summary className="flex cursor-pointer list-none items-center ...">
    ...
  </summary>
  <div className="border-t ...">{children}</div>
</details>
```

- 用原生 `<details>`，**没有任何状态控制**（无 `open` prop、无 `useState`）
- 不支持"默认展开"——必须靠加 `open` 属性
- 没有任何视觉提示"里面有 N 个设置"

`SettingsView.tsx:266-316` 里有 `setCategory` 的 `useEffect` 路由逻辑，**没有任何搜索/筛选**。

### 1.4 实际痛点（按用户反馈排序）

| # | 痛点 | 严重度 |
|---|---|---|
| 1 | 常用旋钮（stream idle timeout）藏在二级折叠下 | 高 |
| 2 | 两张卡片都叫"高级"，且有相似的描述 | 中 |
| 3 | AI Assistant 页面 8 张卡 50+ 设置项，无搜索 | 高 |
| 4 | 改完设置无"已生效"反馈（要靠旁边的 Save 状态条） | 低 |
| 5 | 改完不重启 runtime，stream idle 这种 runtime 级别设置要重启 Kun 子进程才生效，UI 没提示 | 中 |
| 6 | 没"重置为默认值"按钮 — 改坏了只能手动回滚 | 中 |
| 7 | SectionJumpButton 组件已经存在但 AI Assistant 页面没用 | 低 |

### 1.5 与 `docs/AGENTS.md` 禁止项的对齐检查

`docs/AGENTS.md` 明确禁止以下 UI 类。本方案**只重组现有 settings 面板，不引入任何新 UI 类**，逐条核对：

| 禁止项 | 本方案是否触及 | 说明 |
|---|---|---|
| `AgentSwitcher` | ❌ 不触及 | 无新增 agent 切换 |
| `ConnectionStatusBar` | ❌ 不触及 | `Allow local access without a token` 是 **toggle 输入**（写入 `agents.kun.runtimeToken`），不是 status bar |
| `RuntimeDiagnosticsDialog` | ❌ 不触及 | 第 8 张卡是 settings 页面内的"已配置能力快照"，**非弹窗**，**非实时 self-check**；AGENTS.md 禁的是 dialog |
| CodeWhale/Reasonix | ❌ 不触及 | 无 legacy 路径引入 |
| `/usage` / `/runtime` 命令 | ❌ 不触及 | 无新 slash command |
| settings 必须放在 `agents.kun` 下 | ✅ 遵守 | 所有改动仍在 `KunRuntimeSettingsV1` schema 内 |
| Settings → Agents 只显示 Kun | ✅ 遵守 | 重命名只动 label，不动 group 归属 |

**命名微调建议**（避免和 `ConnectionStatusBar` 概念混淆）：
- `kunAssistantAdvanced` 当前叫 "Assistant advanced settings" → 改为 **"本地服务设置"**（描述里强调"本地端口、运行时路径、数据目录、访问令牌"），明确"是配置项不是 status bar"
- `kunAdvanced` 当前叫 "Advanced runtime settings" → 改为 **"运行时调优"**

### 1.6 核心 UX 数据点（围绕 §0 目标）

| 指标 | 当前 | 目标 |
|---|---|---|
| AI Assistant 页面 SettingRow 总数 | ~50 | 不增（甚至略减） |
| 最深路径层数 | 4 层 | ≤ 2 层（卡 → row；卡内不再嵌 disclosure 藏常用项） |
| 已知名称查找耗时 | 5-15 秒（滚 + 扫） | **< 1 秒**（搜索框） |
| 探索浏览最长滚动距离 | ~7 屏 | **≤ 2 屏**（抽卡 + 折叠） |
| 进入设置到改完 stream idle 的最少操作 | 7 次（点 + 滚 + 展开 + 改 + 保存） | **3 次**（搜 → 改 → 保存） |

---

## 2. 优化目标

（与 §0 一致，不再重复）

## 3. 方案（三档可选）

按 §0 目标"找得到 / 快速定位"作为评估标准，三档方案的覆盖度：

| 方案 | Find（搜索） | Browse（结构） | Discover（命名） | 工期 |
|---|---|---|---|---|
| 🟢 A 小改 | ❌ | ✅ 抽运行时卡 + 默认展开 + 跳链 | ✅ 重命名消歧义 | 0.5 天 |
| 🟡 **B 中改** | ✅ **搜索框 + 关键词匹配** | ✅ 含 A | ✅ 含 A | 1.5 天 |
| 🔴 C 大改 | ✅ 含 B | ✅✅ 拆页 + 二级导航 | ✅ 含 B | 4 天 |

### 🟢 方案 A：小改（半天）

不改架构，只把"埋太深"的常用项释放到第一级 + 改命名 + 加跳链。

**改动清单：**

1. **默认展开 `kunAdvanced` 里的 `AdvancedSettingsDisclosure`**
   - `src/renderer/src/components/settings-section-agents.tsx:1022` 的 `<AdvancedSettingsDisclosure>` 加 `defaultOpen` 属性
   - `src/renderer/src/components/settings-controls.tsx:269` 组件签名加 `defaultOpen?: boolean`，把 `<details>` 的 `open` 属性接上
   - **理由**：这个折叠里都是 stream idle / tool storm 这种**用户**需要调的旋钮

2. **抽出"运行时"为新卡片**（P0）
   - 在 `agents` 页第一张卡片（line 428）后插入新 `<SettingsCard title="运行时调优">`
   - 包含四个 `SettingRow`：**Stream idle timeout**、**Tool storm toggle**、**Tool storm window/threshold**、**Tool argument repair**
   - 原 `kunAdvanced` 卡片里这 4 个 row 删除，避免重复

3. **重命名两张"高级"卡片**（P1）
   - `kunAssistantAdvanced` (line 465 en / 465 zh) — "Assistant advanced settings" / "助手高级设置" → **"本地服务设置"**
   - `kunAdvanced` (line 618) — "Advanced runtime settings" / "高级运行设置" → **"运行时调优"**
   - 副标题也微调，强调"是配置项不是 status bar"

4. **加 SectionJumpButton**（P1）
   - 在 `agents` 页最顶（line 428 卡片标题上方）放一排 `SectionJumpButton`，跳到每张卡片的 `ref`
   - 复用 `settings-controls.tsx:61-77` 已有组件，零成本

---

### 🟡 方案 B：中改（1.5 天，**推荐**）

在 A 基础上加**搜索框**——这是"快速定位"诉求下 ROI 最高的改动。

**额外改动：**

5. **在 SettingsView 顶部加搜索框（P0）**
   - `src/renderer/src/components/SettingsView.tsx:976` 之上插一个 `<input type="search">`（保留 placeholder 国际化）
   - 实时（onChange，不需 Enter）过滤所有 `SettingRow`，按 `title + description + t(key)` 文本匹配
   - **匹配策略**：
     - 中文 / 英文 token 化（按空格 / 常见分隔符），AND 匹配
     - 支持模糊：键入 `timeout` 命中 "流式空闲超时"
     - 支持缩写：键入 `mcp` 命中 "外部工具"
     - 不区分大小写
   - **显示策略**：
     - 命中的 row 高亮（黄色背景 1 秒淡出）
     - 未命中的 row `opacity: 0.3; pointer-events: none`
     - 整张无任何命中的卡折叠 + 灰
     - 顶部显示 "显示 3 / 共 47 项"
   - **快捷键**：`/` 聚焦搜索框（像 GitHub）
   - **跨页面**：搜索生效在所有 `SettingsCategory`，不只是 `agents`

6. **"重置此节为默认值"按钮**（P2）
   - 每张 `SettingsCard` 标题右侧加省略号菜单
   - 走 `mergeKunRuntimeSettings(current, defaultKunRuntimeSettings())` 反向 patch

7. **runtime 级别设置加"需重启 runtime"提示**（P2）
   - 标记的 row：stream idle、tool storm、tool argument repair、approval policy、sandbox mode
   - 描述后挂一个小徽章 "需重启生效"

**实现要点：**
- 新建 `src/renderer/src/hooks/use-settings-search.ts`，封装匹配算法（不重依赖 fuse.js 之类，先用原生 includes，必要时再升级）
- `SettingsView.tsx` 的 ctx 传 `searchQuery: string`、`onSearchChange: (q: string) => void`
- 每个 section 的 wrapper 加 `data-search-text` 属性（自动从 children 提取）
- 用 CSS attribute selector + 一层 wrapper 实现不命中 row 的灰化，比逐 row 写 state 简单

**影响范围**：`SettingsView.tsx` + 新建 hook + 每个 section 改 wrapper
**风险**：中，全局搜索要做匹配策略 + 性能测试（50+ row 不卡）
**收益**：覆盖 §0 的 Find 子目标（"知道名字 3 秒到"）

---

### 🔴 方案 C：大改（4 天，含中改全部内容）

在 B 基础上**拆页面**——给 AI Assistant 一级子导航。

**额外改动：**

8. **把 AI Assistant 拆成 3 个一级分类**
   - `SettingsCategory` 加新值：`'agentCore'`、`'agentRuntime'`、`'agentExtensions'`
     - `agentCore` = 当前卡片 1（基础 agent 配置）+ 卡片 2（权限）
     - `agentRuntime` = 当前卡片 7（运行时调优）+ 卡片 6（MCP）
     - `agentExtensions` = 当前卡片 3（computer use）+ 卡片 4（design quality）+ 卡片 5（技能）+ 卡片 8（diagnostics）
   - 侧边栏 `SettingsSidebar.tsx` 加二级导航（或者用 segmented control 在 AI Assistant 页面顶部切换）
   - 旧的 `agents` category 保留作"概览"页（显示 sub-nav 入口卡片）

9. **在每个 section 顶部加"最近修改"指示器**
   - session 内存 diff，列出本次会话改过的 row
   - 一键回滚到会话开始时的值10. **全页面空状态**
    - 搜索无结果时显示"没找到 X。试试搜 'API key' 或 'port'"

**影响范围**：`chat-store-types.ts` 改 `SettingsCategory` union、`SettingsSidebar.tsx` 加子导航、4-5 个 section 文件拆 / 重命名
**风险**：中-高，类型变更需要全文排查（grep `'agents'`、`SettingsRouteSection`），可能影响 deep link
**收益**：解决痛点 1、3、5、6、7 的根治性方案

---

## 4. 推荐路径

围绕目标"快速定位"打分：

| 方案 | 关键能力 | 直接覆盖 | 间接覆盖 | 不覆盖 |
|---|---|---|---|---|
| 🟢 A | 抽卡 + 默认展开 + 重命名 + 跳链 | Browse / Discover | — | Find（没搜索） |
| 🟡 **B（推荐）** | A + **搜索框** | **Find / Browse / Discover** | — | — |
| 🔴 C | B + 拆页 + 最近修改 | Find / Browse / Discover | 解决"8 张卡太多"认知负担 | — |

### 推荐：**B 方案（1.5 天）**

理由：
- **A 不解决 Find** —— 用户知道"stream idle"但还得滚；只要没搜索，3 秒到的目标就达不成
- **搜索框是 Find 场景的唯一银弹** —— 50+ 设置项的页面，搜索比任何结构优化都管用
- **C 解决的是"卡片太多认知负担"** —— 跟"快速定位"关系弱；B 之后用户都能搜到，认知负担自然就轻了
- C 改 `SettingsCategory` union 影响 20+ 处调用，性价比低

如果时间极紧，**最小可交付 = A**（半天），但 Find 目标达不到。

如果产品同学坚持要拆页面（C），建议**等 B 上线 1-2 周后看用户反馈**再决定，避免在没有搜索的时候硬拆（拆完一样找不到）。

---

## 5. 实施细节（方案 A 完整 diff 草稿）

### 5.1 `settings-controls.tsx` 改造

```tsx
// 269: 加 defaultOpen + 受控状态
export function AdvancedSettingsDisclosure({
  title,
  description,
  children,
  defaultOpen = false
}: {
  title: string
  description?: string
  children: ReactNode
  defaultOpen?: boolean
}): ReactElement {
  // 简单方案：纯 uncontrolled，加 open prop
  return (
    <details
      className="group overflow-hidden rounded-xl border ..."
      open={defaultOpen || undefined}
    >
      ...
    </details>
  )
}
```

> 受控版本（保留用户选择）需要 useState + localStorage key，建议用 `useStorage` hook（项目里如果有）。先做无状态版本，够用。

### 5.2 `settings-section-agents.tsx` 抽"运行时"卡片

在 `agents` 基础卡（line 602）后插入：

```tsx
<div className="mt-6">
  <SettingsCard title={t('kunRuntimeShort') /* 新 key: "运行时" */}>
    <SettingRow
      title={t('kunStreamIdleTimeout')}
      description={t('kunStreamIdleTimeoutDesc')}
      control={
        <input
          type="number" min={0} max={3600000} step={1000}
          className="..."
          value={runtimeTuning.streamIdleTimeoutMs}
          onChange={(e) =>
            updateRuntimeTuning({ streamIdleTimeoutMs: Number(e.target.value) })
          }
        />
      }
    />
    <SettingRow
      title={t('kunToolStorm')}
      description={t('kunToolStormDesc')}
      control={
        <Toggle
          checked={runtimeTuning.toolStorm.enabled}
          onChange={(enabled) => updateToolStorm({ enabled })}
        />
      }
    />
    <SettingRow
      title={t('kunToolStormLimits')}
      description={t('kunToolStormLimitsDesc')}
      wideControl
      control={
        <div className="grid gap-3 sm:grid-cols-2">
          {/* windowSize + threshold inputs */}
        </div>
      }
    />
    <SettingRow
      title={t('kunToolArgRepair')}
      description={t('kunToolArgRepairDesc')}
      control={
        <input
          type="number" min={1024} ...
          value={runtimeTuning.toolArgumentRepair.maxStringBytes}
          onChange={(e) =>
            updateToolArgumentRepair({ maxStringBytes: Number(e.target.value) })
          }
        />
      }
    />
  </SettingsCard>
</div>
```

从 `kunAdvanced` 卡片（line 1020-1378）里**删除**对应的 4 个 `SettingRow`（约 line 1319-1378）。

### 5.3 `locales/{en,zh}/settings.json` 新增 key

```json
// 新增
"kunRuntimeShort": "Runtime tuning",
"kunRuntimeShort_zh": "运行时调优",
"kunToolArgRepair": "Tool argument repair",
"kunToolArgRepairDesc": "Maximum bytes for a single tool argument string before the runtime trims it. Default 524288.",
"kunRequiresRuntimeRestart": "Takes effect on next request",  // 运行时徽章
"kunRequiresRuntimeRestart_zh": "下次请求生效",

// 重命名（"两张高级"消歧义）
"kunAssistantAdvanced": "Local service",  // 之前: "Assistant advanced settings"
"kunAssistantAdvanced_zh": "本地服务设置",
"kunAdvanced": "Runtime tuning",  // 之前: "Advanced runtime settings"
"kunAdvanced_zh": "运行时调优"
```

### 5.4 搜索框组件草稿

新建 `src/renderer/src/components/SettingsSearch.tsx`：

```tsx
export function SettingsSearch({
  value, onChange, totalCount, matchedCount
}: {
  value: string
  onChange: (q: string) => void
  totalCount: number
  matchedCount: number
}): ReactElement {
  return (
    <div className="px-3 py-2">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('settingsSearchPlaceholder')}  // "搜索设置…"
        className="w-full rounded-xl border ... px-3 py-2"
      />
      {value && (
        <div className="mt-1 text-[12px] text-ds-muted">
          {t('settingsSearchCount', { matched: matchedCount, total: totalCount })}
          {/* "显示 3 / 共 47 项" */}
        </div>
      )}
    </div>
  )
}
```

搜索逻辑用纯 React state + `useMemo` 计算匹配：

```ts
// useSettingsSearch.ts 草稿
export function useSettingsSearch(
  items: Array<{ id: string; title: string; description?: string; aliases?: string[] }>,
  query: string
): { matchedIds: Set<string>; matchedCount: number } {
  return useMemo(() => {
    if (!query.trim()) return { matchedIds: new Set(), matchedCount: items.length }
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matched = items.filter((item) => {
      const haystack = [item.title, item.description, ...(item.aliases ?? [])]
        .filter(Boolean).join(' ').toLowerCase()
      return tokens.every((tok) => haystack.includes(tok))
    })
    return { matchedIds: new Set(matched.map((m) => m.id)), matchedCount: matched.length }
  }, [items, query])
}
```

### 5.5 把搜索项元数据化

为了让搜索能跨 section 工作，给每个 `SettingRow` 加一个 `searchId` 和 `searchAliases`：

```tsx
<SettingRow
  searchId="kun.streamIdleTimeout"
  searchAliases={['timeout', 'stream', 'idle', '流式', '空闲', '超时']}
  title={t('kunStreamIdleTimeout')}
  ...
/>
```

或者更省事：把 `t('kunStreamIdleTimeout')` 用的 key 名（`kunStreamIdleTimeout`）当作天然的 `searchId`，并在 i18n 资源里加 `searchAliases: ['timeout', 'stream idle', '流式空闲', '超时']` 字段。

---

## 6. 验证清单（围绕 §0 目标）

### 6.1 Find（已知名称）

- [ ] 打开 Settings → 按 `/` 聚焦搜索框 → 输入 `timeout` → 1 秒内看到 "流式空闲超时" 高亮
- [ ] 搜索 `mcp` 命中 "外部工具" 卡片
- [ ] 搜索 `port` 命中 "本地服务端口" + "写入端口" 等多个
- [ ] 清空搜索后所有 row 复原
- [ ] 搜索在所有 `SettingsCategory`（不只是 agents）下都生效

### 6.2 Browse（探索）

- [ ] AI Assistant 页第一屏（不滚）能看到：基础卡 + **运行时调优**卡（含 stream idle / tool storm / tool arg repair）
- [ ] 切换到"运行时调优"卡里的折叠"存储、模型上下文与工具保护"默认展开
- [ ] 页面顶部有一排 jump 按钮（权限 / MCP / 技能 / ...），点一下能跳到对应卡片

### 6.3 Discover（识别）

- [ ] "本地服务设置"（之前叫"助手高级设置"）和"运行时调优"（之前叫"高级运行设置"）描述不再相似
- [ ] runtime 级别 row（stream idle / tool storm / 权限审批）有"下次请求生效"徽章

### 6.4 通用

- [ ] 改动保存后，Kun 子进程实际收到的 config 包含新值（看 `~/.kun/data/config.json`）
- [ ] `npm run typecheck` 干净
- [ ] `npm test` 全绿
- [ ] locales 完整性：en / zh 都加了对应 key，无 i18n 缺失警告
- [ ] 视觉回归：改前后截图对比，卡片间距、标题字号无变化
- [ ] 旧用户偏好兼容性：升级后老用户的 stream idle 仍在"运行时调优"卡（不要被迁移到不同位置）

---

## 7. 开放问题（评审时讨论）

围绕"快速定位"目标，几个需要 PM/设计拍板的点：

1. **搜索的"模糊度"做到多深？**
   - 简单：原样 `includes` 匹配（键入 `timo` 找不到 "timeout"）
   - 中等：加 fuzzy（错一位也能命中）→ 引入 `fuse.js` 或自写编辑距离
   - 推荐：先用简单版，看用户搜索日志再加 fuzzy

2. **搜索要不要带"历史" / "热门" 提示？**
   - 简单：空 query 时显示 placeholder
   - 进阶：空 query 时显示 "最近修改" + "常用 top 5"
   - 成本：多 ~80 行代码 + 本地存储

3. **运行时徽章"下次请求生效"用户会不会困惑？**
   - 含义：当前对话正在跑的请求不会重连，要等下一个 turn
   - 替代说法："新对话生效" / "需新建会话"
   - 建议：先 A/B 两个文案，看哪个点击率（错误率）低

4. **抽卡后，"运行时调优"卡放第几位？**
   - 放第一：高频友好，但违反 IA（agent 配置应该第一）
   - 放第二：IA 友好，运行时跟基础配置相邻
   - 推荐放第二：先让用户配 agent 主体，再调性能

5. **重命名"两张高级"卡的反馈？**
   - "本地服务设置" vs "Local service"
   - "运行时调优" vs "Runtime tuning"
   - 候选："连接 & 存储" / "性能 & 限制" —— 哪个更直观？

6. **要不要给搜索加快捷键 `Cmd+K` / `Ctrl+K`？**（像 Linear / Raycast）
   - 增量成本：~30 行
   - 风险：跟 VS Code / Electron 的 cmd+k 冲突
   - 建议：加，scope 到设置页面内即可
