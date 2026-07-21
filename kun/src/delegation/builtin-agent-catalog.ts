export type BuiltinAgentCatalogEntry = {
  id: string
  name: string
  description: string
  color: string
  toolPolicy: 'readOnly' | 'inherit'
  /** Stable bilingual retrieval facets; never executed as instructions. */
  routingTerms: readonly string[]
}

/**
 * Canonical display, policy, and retrieval metadata for every built-in agent.
 * Runtime profiles and the Electron GUI both consume this table so changing a
 * model override in settings cannot silently replace an agent's real policy.
 */
export const BUILTIN_AGENT_CATALOG = [
  {
    id: 'general', name: 'General Agent', color: '#3b82d8', toolPolicy: 'inherit',
    description: 'Handles broad implementation and multi-step work when no narrower specialist fits.',
    routingTerms: ['general', 'implementation', 'multi-step', '通用', '实现', '多步骤']
  },
  {
    id: 'explore', name: 'Repository Explorer', color: '#1d9e75', toolPolicy: 'readOnly',
    description: 'Locates files, symbols, ownership, and code paths without modifying the workspace.',
    routingTerms: ['explore', 'search', 'find', 'repository', '定位', '搜索', '查找', '代码路径']
  },
  {
    id: 'component-designer', name: 'Component Designer', color: '#7f77dd', toolPolicy: 'inherit',
    description: 'Builds one focused interactive component prototype.',
    routingTerms: ['component', 'prototype', 'ui', 'interaction', '组件', '原型', '交互']
  },
  {
    id: 'design-reviewer', name: 'Design Reviewer', color: '#7f77dd', toolPolicy: 'readOnly',
    description: 'Reviews visual hierarchy, typography, spacing, motion, accessibility, and interaction quality.',
    routingTerms: ['design review', 'visual', 'ux', 'accessibility', '设计审查', '视觉', '可访问性']
  },
  {
    id: 'over-engineering-reviewer', name: 'Over-Engineering Reviewer', color: '#e8943a', toolPolicy: 'readOnly',
    description: 'Finds removable complexity, speculative abstractions, and simpler native alternatives.',
    routingTerms: ['over-engineering', 'yagni', 'complexity', 'simplify', '过度设计', '复杂度', '简化']
  },
  {
    id: 'code-reviewer', name: 'Code Reviewer', color: '#2563eb', toolPolicy: 'readOnly',
    description: 'Reviews scoped changes for correctness, regressions, maintainability, and merge readiness.',
    routingTerms: ['code review', 'diff', 'regression', 'merge', '代码审查', '评审', '回归']
  },
  {
    id: 'test-engineer', name: 'Test Engineer', color: '#10b981', toolPolicy: 'inherit',
    description: 'Designs and implements focused unit, integration, and regression tests.',
    routingTerms: ['test', 'testing', 'unit', 'integration', 'regression', '测试', '单测', '回归测试']
  },
  {
    id: 'security-auditor', name: 'Security Auditor', color: '#dc2626', toolPolicy: 'readOnly',
    description: 'Performs an OWASP-aligned audit of trust boundaries and vulnerabilities without modifying code.',
    routingTerms: ['security audit', 'vulnerability', 'authentication', 'authorization', 'threat', '安全审计', '漏洞', '鉴权', '认证', '授权']
  },
  {
    id: 'web-performance-auditor', name: 'Web Performance Auditor', color: '#f59e0b', toolPolicy: 'readOnly',
    description: 'Audits Core Web Vitals, loading, rendering, bundles, and network performance.',
    routingTerms: ['web performance audit', 'lcp', 'inp', 'cls', 'lighthouse', 'bundle', '网页性能审计', '首屏', '包体积']
  },
  {
    id: 'api-and-interface-design', name: 'API & Interface Architect', color: '#3b82d8', toolPolicy: 'inherit',
    description: 'Designs stable public contracts, compatibility, validation, pagination, and errors.',
    routingTerms: ['api', 'interface', 'contract', 'schema', 'compatibility', '接口', '契约', '兼容']
  },
  {
    id: 'browser-testing-with-devtools', name: 'Web QA Planner', color: '#1d9e75', toolPolicy: 'readOnly',
    description: 'Read-only Web QA planner for browser, accessibility, responsive, console, network, and screenshot verification scripts.',
    routingTerms: ['browser qa plan', 'devtools', 'responsive', 'console', 'network', '浏览器测试计划', '响应式', '控制台']
  },
  {
    id: 'ci-cd-and-automation', name: 'CI/CD Engineer', color: '#e8943a', toolPolicy: 'inherit',
    description: 'Builds deterministic pipelines, quality gates, caching, releases, and rollback-safe deployments.',
    routingTerms: ['ci', 'cd', 'pipeline', 'automation', 'github actions', '流水线', '持续集成', '自动化']
  },
  {
    id: 'code-review-and-quality', name: 'Code Quality Reviewer', color: '#2563eb', toolPolicy: 'readOnly',
    description: 'Performs read-only multi-axis correctness, architecture, security, performance, and test review.',
    routingTerms: ['quality review', 'architecture review', 'maintainability', '代码质量', '架构审查', '可维护性']
  },
  {
    id: 'code-simplification', name: 'Code Simplification Engineer', color: '#7f77dd', toolPolicy: 'inherit',
    description: 'Reduces unnecessary complexity while preserving behavior.',
    routingTerms: ['simplify code', 'refactor', 'remove abstraction', '简化代码', '重构', '删除抽象']
  },
  {
    id: 'context-engineering', name: 'Context Engineer', color: '#1d9e75', toolPolicy: 'readOnly',
    description: 'Builds a minimal authoritative context pack with files, contracts, tests, and data flow.',
    routingTerms: ['context', 'data flow', 'dependencies', 'authoritative files', '上下文', '数据流', '依赖关系']
  },
  {
    id: 'debugging-and-error-recovery', name: 'Root Cause Debugger', color: '#d85a30', toolPolicy: 'inherit',
    description: 'Reproduces, localizes, fixes, and regression-tests failures systematically.',
    routingTerms: ['debug', 'root cause', 'timeout', 'intermittent', 'error recovery', '排查', '调试', '根因', '超时', '偶发']
  },
  {
    id: 'deprecation-and-migration', name: 'Migration Engineer', color: '#e8943a', toolPolicy: 'inherit',
    description: 'Plans and implements staged compatibility, data migration, telemetry, and rollback.',
    routingTerms: ['migration', 'deprecation', 'compatibility', 'rollback', '迁移', '废弃', '兼容', '回滚']
  },
  {
    id: 'documentation-and-adrs', name: 'Documentation & ADR Engineer', color: '#3b82d8', toolPolicy: 'inherit',
    description: 'Writes accurate architecture decisions, operational guides, and API documentation.',
    routingTerms: ['documentation', 'adr', 'decision record', 'guide', '文档', '架构决策', '说明']
  },
  {
    id: 'doubt-driven-development', name: 'Doubt-Driven Reviewer', color: '#d4537e', toolPolicy: 'readOnly',
    description: 'Challenges assumptions and designs with fresh-context adversarial evidence.',
    routingTerms: ['challenge assumptions', 'adversarial review', 'counterexample', '质疑', '反例', '假设']
  },
  {
    id: 'frontend-ui-engineering', name: 'Frontend UI Engineer', color: '#7f77dd', toolPolicy: 'inherit',
    description: 'Builds accessible, responsive, product-quality interfaces and validates interactions.',
    routingTerms: ['frontend', 'ui', 'react', 'css', 'accessibility', 'responsive', '前端', '界面', '响应式']
  },
  {
    id: 'git-workflow-and-versioning', name: 'Git Workflow Engineer', color: '#e8943a', toolPolicy: 'inherit',
    description: 'Handles scoped branches, atomic commits, versioning, conflicts, and history safety.',
    routingTerms: ['git', 'branch', 'commit', 'version', 'conflict', '分支', '提交', '版本', '冲突']
  },
  {
    id: 'idea-refine', name: 'Idea Refinement Partner', color: '#d4537e', toolPolicy: 'readOnly',
    description: 'Turns raw ideas into compared options, MVP boundaries, risks, and validation experiments.',
    routingTerms: ['idea', 'brainstorm', 'mvp', 'options', '创意', '想法', '方案比较', '最小产品']
  },
  {
    id: 'incremental-implementation', name: 'Incremental Implementation Engineer', color: '#10b981', toolPolicy: 'inherit',
    description: 'Delivers thin, buildable, continuously verified vertical slices.',
    routingTerms: ['incremental implementation', 'vertical slice', 'small steps', '增量实现', '垂直切片', '小步']
  },
  {
    id: 'interview-me', name: 'Requirements Interviewer', color: '#3b82d8', toolPolicy: 'readOnly',
    description: 'Finds requirement gaps and produces prioritized high-information questions for the parent.',
    routingTerms: ['requirements interview', 'clarify', 'questions', '需求访谈', '澄清', '提问']
  },
  {
    id: 'observability-and-instrumentation', name: 'Observability Engineer', color: '#1d9e75', toolPolicy: 'inherit',
    description: 'Designs structured logs, metrics, traces, SLOs, dashboards, and actionable alerts.',
    routingTerms: ['observability', 'logging', 'metrics', 'tracing', 'slo', '监控', '日志', '指标', '链路']
  },
  {
    id: 'performance-optimization', name: 'Performance Engineer', color: '#f59e0b', toolPolicy: 'inherit',
    description: 'Measures bottlenecks, optimizes dominant costs, and proves before/after impact.',
    routingTerms: ['performance optimization', 'lcp', 'bundle size', 'latency', 'profiling', '性能优化', '包体积', '延迟']
  },
  {
    id: 'planning-and-task-breakdown', name: 'Implementation Planner', color: '#7f77dd', toolPolicy: 'readOnly',
    description: 'Produces dependency-aware, acceptance-driven, verifiable implementation tasks.',
    routingTerms: ['planning', 'task breakdown', 'parallel tasks', 'dependencies', '计划', '任务拆解', '拆分', '并行任务']
  },
  {
    id: 'security-and-hardening', name: 'Security Hardening Engineer', color: '#dc2626', toolPolicy: 'inherit',
    description: 'Threat-models and implements scoped security controls with regression evidence.',
    routingTerms: ['security fix', 'hardening', 'authentication', 'authorization', 'vulnerability remediation', '安全修复', '安全加固', '鉴权', '漏洞修复']
  },
  {
    id: 'shipping-and-launch', name: 'Release Readiness Engineer', color: '#e8943a', toolPolicy: 'readOnly',
    description: 'Makes evidence-based go/no-go, rollout, monitoring, and rollback plans.',
    routingTerms: ['release readiness', 'launch', 'rollout', 'go no-go', '发布准备', '上线', '灰度', '回滚']
  },
  {
    id: 'source-driven-development', name: 'Source-Driven Researcher', color: '#3b82d8', toolPolicy: 'readOnly',
    description: 'Grounds implementation guidance in authoritative version-matched sources.',
    routingTerms: ['official documentation', 'primary source', 'version', 'source research', '官方文档', '权威来源', '版本核对']
  },
  {
    id: 'spec-driven-development', name: 'Specification Engineer', color: '#d4537e', toolPolicy: 'readOnly',
    description: 'Creates explicit scenarios, interfaces, acceptance criteria, non-goals, and open questions.',
    routingTerms: ['specification', 'acceptance criteria', 'scenarios', 'requirements', '规格', '验收标准', '场景']
  },
  {
    id: 'test-driven-development', name: 'TDD Engineer', color: '#10b981', toolPolicy: 'inherit',
    description: 'Runs red-green-refactor with behavior-focused regression proof.',
    routingTerms: ['tdd', 'red green refactor', 'test first', '测试驱动', '红绿重构', '先写测试']
  },
  {
    id: 'using-agent-skills', name: 'Engineering Workflow Advisor', color: '#7f77dd', toolPolicy: 'readOnly',
    description: 'Maps work to the smallest suitable standalone agent sequence or a missing-role brief.',
    routingTerms: ['agent workflow', 'choose agent', 'delegation plan', '代理选择', '工作流', '派发']
  }
] as const satisfies readonly BuiltinAgentCatalogEntry[]

export const BUILTIN_AGENT_CATALOG_BY_ID: Readonly<Record<string, BuiltinAgentCatalogEntry>> =
  Object.fromEntries(BUILTIN_AGENT_CATALOG.map((entry) => [entry.id, entry]))
