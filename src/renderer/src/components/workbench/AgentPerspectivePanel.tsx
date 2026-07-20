import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  AlertTriangle,
  Check,
  Clipboard,
  Clock3,
  RefreshCw,
  ScanSearch
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ModelRequestTraceBody,
  ModelRequestTraceHeaders,
  ModelRequestTraceRecord
} from '../../agent/model-request-traces'
import { useModelRequestTraces } from './useModelRequestTraces'

type DetailSection = 'overview' | 'request' | 'response' | 'decoded'
type BodyMode = 'pretty' | 'raw'

const SECTION_KEYS: ReadonlyArray<{ id: DetailSection; label: string }> = [
  { id: 'overview', label: 'agentPerspectiveOverview' },
  { id: 'request', label: 'agentPerspectiveRequest' },
  { id: 'response', label: 'agentPerspectiveResponse' },
  { id: 'decoded', label: 'agentPerspectiveDecoded' }
]

export function AgentPerspectivePanel({
  threadId,
  active,
  threadRunning
}: {
  threadId: string | null
  active: boolean
  threadRunning: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const traces = useModelRequestTraces({ threadId, visible: active, threadRunning })
  const [section, setSection] = useState<DetailSection>('overview')

  useEffect(() => setSection('overview'), [threadId, traces.selectedId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-sidebar text-ds-ink">
      <header className="flex shrink-0 items-center gap-2 border-b border-ds-border-muted px-3 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <ScanSearch className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold">{t('agentPerspectiveTitle')}</h2>
          <p className="truncate text-[10px] text-ds-muted">
            {t('agentPerspectiveSubtitle', { count: traces.records.length })}
          </p>
        </div>
        {traces.activeCount > 0 ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-label={t('agentPerspectivePending')} />
        ) : null}
        <button
          type="button"
          onClick={traces.refresh}
          disabled={!threadId || traces.loading}
          className="rounded-md p-1.5 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40"
          aria-label={t('agentPerspectiveRefresh')}
          data-tooltip={t('agentPerspectiveRefresh')}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${traces.loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {!threadId ? (
        <EmptyState text={t('agentPerspectiveUnsupported')} />
      ) : traces.loading && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoading')} spinning />
      ) : traces.error && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoadError', { error: traces.error })} warning />
      ) : traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveEmpty')} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(148px,0.38fr)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-ds-border-muted">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {traces.records.map((record) => (
                <RequestListItem
                  key={record.id}
                  record={record}
                  selected={record.id === traces.selectedId}
                  onSelect={() => traces.select(record.id)}
                />
              ))}
            </div>
            {traces.nextCursor ? (
              <button
                type="button"
                onClick={traces.loadOlder}
                disabled={traces.loadingOlder}
                className="m-1.5 rounded-md border border-ds-border-muted px-2 py-1.5 text-[10px] text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
              >
                {traces.loadingOlder ? t('agentPerspectiveLoading') : t('agentPerspectiveLoadOlder')}
              </button>
            ) : null}
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col">
            <nav
              role="tablist"
              aria-label={t('agentPerspectiveDetailSections')}
              className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-ds-border-muted px-2 pt-1.5"
            >
              {SECTION_KEYS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={section === item.id}
                  onClick={() => setSection(item.id)}
                  className={`whitespace-nowrap border-b-2 px-2 py-1.5 text-[10px] font-medium transition ${
                    section === item.id
                      ? 'border-accent text-ds-ink'
                      : 'border-transparent text-ds-muted hover:text-ds-ink'
                  }`}
                >
                  {t(item.label)}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {traces.selected ? (
                <TraceDetail record={traces.selected} section={section} />
              ) : (
                <EmptyState text={t('agentPerspectiveEmpty')} />
              )}
            </div>
          </main>
        </div>
      )}

      {traces.error && traces.records.length > 0 ? (
        <div role="alert" className="shrink-0 border-t border-amber-500/25 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          {t('agentPerspectiveLoadError', { error: traces.error })}
        </div>
      ) : null}
      {traces.warnings.map((warning) => (
        <div key={warning} role="status" className="shrink-0 border-t border-amber-500/25 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          {warning}
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  text,
  spinning = false,
  warning = false
}: {
  text: string
  spinning?: boolean
  warning?: boolean
}): ReactElement {
  const Icon = warning ? AlertTriangle : spinning ? RefreshCw : ScanSearch
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-ds-muted">
      <Icon className={`h-5 w-5 ${spinning ? 'animate-spin' : ''}`} aria-hidden />
      <p className="max-w-72 leading-5">{text}</p>
    </div>
  )
}

function RequestListItem({
  record,
  selected,
  onSelect
}: {
  record: ModelRequestTraceRecord
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const status = record.response?.status
  const failed = record.status === 'transport_error' || record.status === 'capture_error' || (status !== undefined && status >= 400)
  const pending = record.status === 'pending'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`mb-1 w-full rounded-lg border px-2 py-2 text-left transition ${
        selected
          ? 'border-accent/45 bg-accent/8'
          : 'border-transparent hover:border-ds-border-muted hover:bg-ds-hover'
      }`}
      aria-pressed={selected}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : pending ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />
        <span className="truncate text-[10px] font-semibold">POST {status ?? '…'}</span>
        <span className="ml-auto shrink-0 text-[9px] tabular-nums text-ds-faint">#{record.attempt}</span>
      </div>
      <div className="mt-1 truncate text-[10px] text-ds-muted" title={record.model}>{record.model}</div>
      <div className="mt-1 flex items-center gap-1 text-[9px] text-ds-faint">
        <Clock3 className="h-2.5 w-2.5" aria-hidden />
        <span>{formatTimestamp(record.startedAt)}</span>
        <span className="ml-auto">{attemptLabel(t, record.attemptReason)}</span>
      </div>
    </button>
  )
}

function TraceDetail({
  record,
  section
}: {
  record: ModelRequestTraceRecord
  section: DetailSection
}): ReactElement {
  const { t } = useTranslation('common')
  if (section === 'request') {
    return (
      <div className="space-y-4">
        <DetailBlock title={t('agentPerspectiveUrl')} value={record.request.url} copyValue={record.request.url} mono />
        <HeadersTable headers={record.request.headers} />
        <BodyViewer body={record.request.body} title={t('agentPerspectiveBody')} />
        {record.request.urlRedacted || record.request.headers.redactedNames.length > 0 ? <RedactionNotice /> : null}
      </div>
    )
  }
  if (section === 'response') {
    if (!record.response) return <EmptyState text={t('agentPerspectiveNoResponse')} />
    return (
      <div className="space-y-4">
        <DetailBlock
          title={t('agentPerspectiveStatus')}
          value={`${record.response.status} ${record.response.statusText}`.trim()}
        />
        <HeadersTable headers={record.response.headers} />
        {record.response.body ? (
          <BodyViewer body={record.response.body} title={t('agentPerspectiveRawResponse')} />
        ) : (
          <EmptyState text={record.response.captureError || t('agentPerspectiveNoResponse')} />
        )}
        {record.response.headers.redactedNames.length > 0 ? <RedactionNotice /> : null}
      </div>
    )
  }
  if (section === 'decoded') {
    if (!record.decoded) return <EmptyState text={t('agentPerspectiveNoDecoded')} />
    return (
      <BodyViewer
        title={t('agentPerspectiveDecoded')}
        body={textBody(JSON.stringify(record.decoded))}
        preferPretty
      />
    )
  }
  return <Overview record={record} />
}

function Overview({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  const rows: Array<[string, string]> = [
    [t('agentPerspectiveProvider'), record.provider],
    [t('agentPerspectiveModel'), record.model],
    [t('agentPerspectiveEndpointFormat'), record.endpointFormat],
    [t('agentPerspectiveAttempt'), `${record.attempt} · ${attemptLabel(t, record.attemptReason)}`],
    [t('agentPerspectiveStatus'), statusLabel(t, record)],
    [t('agentPerspectiveStartedAt'), formatTimestamp(record.startedAt, true)]
  ]
  if (record.timeToHeadersMs !== undefined) rows.push([t('agentPerspectiveTimeToHeaders'), `${Math.round(record.timeToHeadersMs)} ms`])
  if (record.durationMs !== undefined) rows.push([t('agentPerspectiveDuration'), `${Math.round(record.durationMs)} ms`])
  return (
    <div className="space-y-4">
      <dl className="overflow-hidden rounded-lg border border-ds-border-muted">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(100px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted last:border-b-0">
            <dt className="bg-ds-surface-subtle px-2.5 py-2 text-[10px] font-medium text-ds-muted">{label}</dt>
            <dd className="min-w-0 break-words px-2.5 py-2 text-[10px]">{value}</dd>
          </div>
        ))}
      </dl>
      <DetailBlock title={t('agentPerspectiveUrl')} value={record.request.url} copyValue={record.request.url} mono />
      {record.error ? <Notice text={record.error} warning /> : null}
      {record.captureWarnings?.map((warning) => <Notice key={warning} text={warning} warning />)}
      {record.request.body.truncated || record.response?.body?.truncated ? <TruncationNotice /> : null}
    </div>
  )
}

function HeadersTable({ headers }: { headers: ModelRequestTraceHeaders }): ReactElement {
  const { t } = useTranslation('common')
  const entries = Object.entries(headers.values)
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ds-muted">{t('agentPerspectiveHeaders')}</h3>
        <CopyButton value={JSON.stringify(headers.values, null, 2)} />
      </div>
      <div className="overflow-hidden rounded-lg border border-ds-border-muted">
        {entries.length === 0 ? (
          <div className="px-2.5 py-2 text-[10px] text-ds-faint">—</div>
        ) : entries.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[minmax(100px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted font-mono text-[10px] last:border-b-0">
            <div className="break-all bg-ds-surface-subtle px-2.5 py-2 text-ds-muted">{name}</div>
            <div className="min-w-0 break-all px-2.5 py-2">{value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function BodyViewer({
  body,
  title,
  preferPretty = false
}: {
  body: ModelRequestTraceBody
  title: string
  preferPretty?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const pretty = useMemo(() => prettyJson(body.text), [body.text])
  const [mode, setMode] = useState<BodyMode>(preferPretty || pretty !== null ? 'pretty' : 'raw')
  const value = mode === 'pretty' && pretty !== null ? pretty : body.text
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1">
        <h3 className="mr-auto text-[10px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
        {pretty !== null ? (
          <div className="flex rounded-md bg-ds-surface-subtle p-0.5 text-[9px]">
            {(['pretty', 'raw'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded px-1.5 py-0.5 ${mode === item ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted'}`}
              >
                {t(item === 'pretty' ? 'agentPerspectivePretty' : 'agentPerspectiveRaw')}
              </button>
            ))}
          </div>
        ) : null}
        <CopyButton value={value} />
      </div>
      <textarea
        readOnly
        value={value}
        spellCheck={false}
        aria-label={title}
        className="h-64 w-full resize-y rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[10px] leading-4 text-ds-ink outline-none"
      />
      <div className="mt-1 flex items-center justify-between text-[9px] text-ds-faint">
        <span>{body.capturedBytes.toLocaleString()} / {body.originalBytes.toLocaleString()} B</span>
        {body.truncated ? <span>{t('agentPerspectiveTruncated')}</span> : null}
      </div>
    </section>
  )
}

function DetailBlock({
  title,
  value,
  copyValue,
  mono = false
}: {
  title: string
  value: string
  copyValue?: string
  mono?: boolean
}): ReactElement {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
        {copyValue ? <CopyButton value={copyValue} /> : null}
      </div>
      <div className={`break-all rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 py-2 text-[10px] ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </section>
  )
}

function CopyButton({ value }: { value: string }): ReactElement {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }
  const Icon = copied ? Check : Clipboard
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded p-1 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
      aria-label={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
      data-tooltip={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

function Notice({ text, warning = false }: { text: string; warning?: boolean }): ReactElement {
  return (
    <div className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[10px] leading-4 ${warning ? 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300' : 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted'}`}>
      {warning ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> : null}
      <span>{text}</span>
    </div>
  )
}

function RedactionNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveRedacted')} />
}

function TruncationNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveTruncationNotice')} warning />
}

function textBody(value: string): ModelRequestTraceBody {
  const bytes = new TextEncoder().encode(value).byteLength
  return { text: value, capturedBytes: bytes, originalBytes: bytes, truncated: false }
}

function prettyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return null
  }
}

function formatTimestamp(value: string, full = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, full
    ? { dateStyle: 'medium', timeStyle: 'medium' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function attemptLabel(
  t: (key: string) => string,
  reason: ModelRequestTraceRecord['attemptReason']
): string {
  if (reason === 'transport_retry') return t('agentPerspectiveTransportRetry')
  if (reason === 'stream_options_fallback') return t('agentPerspectiveStreamFallback')
  return t('agentPerspectiveInitial')
}

function statusLabel(t: (key: string) => string, record: ModelRequestTraceRecord): string {
  if (record.status === 'pending') return t('agentPerspectivePending')
  if (record.status === 'transport_error') return t('agentPerspectiveTransportError')
  if (record.status === 'capture_error') return t('agentPerspectiveCaptureError')
  return `${t('agentPerspectiveCompleted')}${record.response ? ` · HTTP ${record.response.status}` : ''}`
}
