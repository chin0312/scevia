/* Portfolio workspace: the one place to manage what a portfolio is made of.
   Accounts (financial identities) · Sources (how records arrive) · Transactions (records and decisions) ·
   Imports & reconciliation (batches, replacements, review) · Data coverage (what the figures are based on).
   Accounts, sources and coverage describe the sample portfolio behind Overview, Analytics and Risk. Transactions and
   imports are a record-management sample: decisions there never change those figures, nothing is uploaded, and only
   bundled sample files can be imported. Every decision is reversible; nothing deletes source data. */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'
import { Drawer, Modal, useToast } from '../components/overlays'
import { useHashScroll } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, Seg, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import { HISTORY_START, TODAY } from '../data/portfolio'
import { SAMPLE_MARKET_EVENTS } from '../data/sampleMarkets'
import { SAMPLE_FILES, type FinRecord, type Outcome, type RecordType, type WorkspaceAccount } from '../data/sampleRecords'
import type { Platform } from '../data/types'
import { account, coverage, fmtDate, sourceOf } from '../lib/finance'
import { fmt, qty, sfmt } from '../lib/format'
import { parseMoney, parsePrice, parseShares } from '../lib/inputs'
import * as R from '../lib/records'
import { pushLocalEvent, useWorkspace, type Workspace } from '../lib/useWorkspace'

export const SECTIONS = [
  { id: 'accounts', label: 'Accounts', icon: 'db' },
  { id: 'sources', label: 'Sources', icon: 'link' },
  { id: 'transactions', label: 'Transactions', icon: 'list' },
  { id: 'imports', label: 'Imports & reconciliation', icon: 'download' },
  { id: 'coverage', label: 'Data coverage', icon: 'shield' },
] as const satisfies readonly { id: string; label: string; icon: IconName }[]
type Section = (typeof SECTIONS)[number]['id']
const PAGE = 10
const SOURCE_LABEL = { api: 'API sync', csv: 'CSV import', manual: 'Manual' } as const
const KIND_LABEL = { connected: 'Connected', imported: 'Imported', manual: 'Manual' } as const
const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const newId = (p: string) => `${p}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
const acctName = (ws: Workspace, id: string) => { const a = ws.accounts.find((x) => x.id === id); return a ? `${PLATFORM_NAME[a.venue]} · ${a.label}` : 'Unknown account' }

export default function Portfolio() {
  useHashScroll()
  const { section: raw } = useParams()
  const section: Section = SECTIONS.some((s) => s.id === raw) ? (raw as Section) : 'accounts'
  const nav = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [ws, setWs, persisted] = useWorkspace()
  const [history, setHistory] = useState<{ label: string; ws: Workspace }[]>([])
  const [importing, setImporting] = useState<{ file?: string; accountId?: string } | null>(null)
  const [manual, setManual] = useState<string | null>(null)
  const commit = (label: string, next: Workspace) => { setHistory((h) => [...h.slice(-9), { label, ws }]); setWs(next) }
  const undo = () => { const last = history.at(-1); if (!last) return; setWs(last.ws); setHistory((h) => h.slice(0, -1)); toast(`Undid: ${last.label}`, 'info') }

  // Quick actions from search and menus arrive as one-time URL actions.
  useEffect(() => {
    const a = params.get('action')
    if (!a) return
    if (a === 'import') setImporting({})
    if (a === 'manual') setManual(params.get('account') ?? '')
    const next = new URLSearchParams(params); next.delete('action'); setParams(next, { replace: true })
  }, [params, setParams])

  const reviewCount = ws.records.filter((r) => R.statusOf(r, ws.records) === 'review').length
  const title = SECTIONS.find((s) => s.id === section)!.label
  return (
    <div className="shell">
      <aside className="rail" aria-label="Portfolio sections">
        <h6 className="caps">Portfolio</h6>
        <ol>{SECTIONS.map((s) => (
          <li key={s.id}><NavLink to={`/portfolio/${s.id}`} className={({ isActive }) => cx(isActive && 'on')}><Icon name={s.icon} />{s.label}
            {s.id === 'transactions' && <span className="count">{ws.records.length}</span>}{s.id === 'imports' && reviewCount > 0 && <span className="flag">{reviewCount}</span>}</NavLink></li>
        ))}</ol>
        <div className="rail-card"><b>Sample portfolio</b>Accounts and coverage describe the portfolio behind your figures. Transactions and imports are a record-management sample.</div>
      </aside>
      <main>
        <section className="page-head anchor" id="summary">
          <div><div className="caps"><span className="accent">Portfolio</span> · Sample portfolio · {ws.accounts.length} accounts</div><h1>{title}</h1></div>
          <div className="actions">
            <Button icon="download" onClick={() => setImporting({})}>Import CSV…</Button>
            <Button icon="plus" onClick={() => setManual('')}>Add record…</Button>
          </div>
        </section>
        {!persisted && <Callout tone="warn" icon="alert"><b>Changes aren’t being saved.</b> This browser refused to keep them in this tab, so they’ll be lost when you reload or leave. Everything you change still applies until then.</Callout>}
        {(section === 'transactions' || section === 'imports') && <Callout icon="shield"><b>Record-management sample.</b> These records are fictional. Including, excluding or correcting them doesn’t change Overview, Analytics, Risk or Scenario Lab, and nothing is uploaded.</Callout>}
        {history.length > 0 && <div className="undo-line" role="status"><span>Last change: {history.at(-1)!.label}.</span><button type="button" className="link" onClick={undo}>Undo: {history.at(-1)!.label}</button></div>}
        {section === 'accounts' && <Accounts ws={ws} onRename={(id, label) => commit(`Renamed account to ${label}`, { ...ws, accounts: ws.accounts.map((a) => (a.id === id ? { ...a, label } : a)) })}
          onImport={(id) => setImporting({ accountId: id })} onManual={(id) => setManual(id)} />}
        {section === 'sources' && <Sources ws={ws} onImport={() => setImporting({})} onManual={() => setManual('')} />}
        {section === 'transactions' && <Transactions ws={ws} commit={commit} />}
        {section === 'imports' && <Imports ws={ws} reviewCount={reviewCount} onImport={(file, accountId) => setImporting({ file, accountId })} />}
        {section === 'coverage' && <Coverage ws={ws} />}
        <div className="footer-note"><span>Original records stay inspectable; decisions are reversible and never delete source data.</span><span>Sample portfolio · fictional data</span></div>
      </main>
      {importing && <ImportFlow ws={ws} preset={importing} onClose={() => setImporting(null)} onDone={(label, next, review, batchId) => {
        commit(label, next); setImporting(null)
        pushLocalEvent({ id: `import:${batchId}`, batchId, at: new Date().toISOString(), category: 'imports', title: label, body: review ? `${review} row${review === 1 ? '' : 's'} need review before they count` : 'All rows included', to: review ? `/portfolio/transactions?status=review&batch=${encodeURIComponent(batchId)}` : '/portfolio/imports' })
        nav(review ? '/portfolio/transactions?status=review' : '/portfolio/imports')
      }} />}
      {manual != null && <ManualRecord ws={ws} preset={manual} onClose={() => setManual(null)} onAdd={(next, label) => { commit(label, next); setManual(null); toast(label); nav('/portfolio/transactions') }} />}
    </div>
  )
}

/* ── Accounts ─────────────────────────────────────────────── */
function Accounts({ ws, onRename, onImport, onManual }: { ws: Workspace; onRename: (id: string, label: string) => void; onImport: (id: string) => void; onManual: (id: string) => void }) {
  const nav = useNavigate()
  const [renaming, setRenaming] = useState<WorkspaceAccount | null>(null)
  return (<>
    <Card id="accounts">
      <CardHeader title="Financial accounts" sub="One wallet or venue login each. Several can share a venue; one account can have several sources." info="A venue (Polymarket, Kalshi) is where positions are held. An account is one wallet or login there. A source (API sync, CSV file, manual entry) is how its records arrive. Being connected doesn’t mean the history is complete." />
      <div className="card-b acct-grid">
        {ws.accounts.map((a) => {
          const rs = ws.records.filter((r) => r.accountId === a.id), times = rs.map((r) => R.effective(r).time).sort()
          const review = rs.filter((r) => R.statusOf(r, ws.records) === 'review').length
          const unknown = rs.filter((r) => R.statusOf(r, ws.records) === 'included' && R.cashEffect(R.effective(r)) == null).length
          const srcs = [...new Set([...a.sources, ...rs.map((r) => r.source)])]
          return (
            <div className="acct-card" key={a.id}>
              <div className="row"><PlatformBadge p={a.venue} size={20} /><b className="acct-name" title={a.label}>{a.label}</b><Chip tone={a.kind === 'connected' ? 'info' : undefined}>{KIND_LABEL[a.kind]}</Chip></div>
              <dl className="kv kv-sm">
                <dt>Venue</dt><dd>{PLATFORM_NAME[a.venue]}</dd>
                <dt>Sources</dt><dd>{srcs.map((s) => SOURCE_LABEL[s]).join(' + ')}{a.connection ? ` · ${a.connection}` : ''}</dd>
                <dt>Last observed</dt><dd>{a.lastObserved ? when(a.lastObserved) : 'No connection'}</dd>
                <dt>Records</dt><dd>{rs.length}{times.length ? ` · ${when(times[0])} – ${when(times.at(-1)!)}` : ''}</dd>
                <dt>Opening state</dt><dd className={cx(!a.openingDeclared && 'warn-fg')}>{a.openingDeclared ? 'Declared' : 'Unknown before first record'}</dd>
                <dt>In figures</dt><dd>{a.inAnalytics ? 'Sample portfolio' : 'Records only'}</dd>
              </dl>
              {(review > 0 || unknown > 0) && <small className="stale">{[review ? `${review} need review` : '', unknown ? `${unknown} with unknown amounts` : ''].filter(Boolean).join(' · ')}</small>}
              <div className="row acct-actions">
                <Button size="sm" onClick={() => nav(`/portfolio/transactions?account=${encodeURIComponent(a.id)}`)}>Transactions</Button>
                <Button size="sm" variant="ghost" onClick={() => onImport(a.id)}>Import…</Button>
                <Button size="sm" variant="ghost" onClick={() => onManual(a.id)}>Add record…</Button>
                <Button size="sm" variant="ghost" icon="edit" aria-label={`Rename ${a.label}`} onClick={() => setRenaming(a)} />
              </div>
            </div>
          )
        })}
      </div>
    </Card>
    {renaming && <RenameAccount a={renaming} onClose={() => setRenaming(null)} onSave={(label) => { onRename(renaming.id, label); setRenaming(null) }} />}
  </>)
}
function RenameAccount({ a, onClose, onSave }: { a: WorkspaceAccount; onClose: () => void; onSave: (label: string) => void }) {
  const [v, setV] = useState(a.label)
  return (
    <Modal title="Rename account" sub="The name is a label; the account’s identity and records don’t change" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</Button></>}>
      <label className="add-field"><span className="l">Account name</span><input data-autofocus className="text-input" value={v} maxLength={60} onChange={(e) => setV(e.target.value)} aria-label="Account name" /></label>
    </Modal>
  )
}

/* ── Sources ──────────────────────────────────────────────── */
function Sources({ ws, onImport, onManual }: { ws: Workspace; onImport: () => void; onManual: () => void }) {
  const csv = ws.batches.filter((b) => b.status === 'active'), manual = ws.records.filter((r) => r.source === 'manual')
  const connected = ws.accounts.filter((a) => a.kind === 'connected')
  return (<>
    <Card id="sources" flush>
      <CardHeader pad title="Sources in this portfolio" sub="How each account’s records arrive. A source isn’t a venue: one account can combine several." />
      <div className="src-list">
        {connected.map((a) => (
          <div className="src-row" key={a.id}><PlatformBadge p={a.venue} />
            <div><b>{a.connection === 'public address tracking' ? 'Public wallet tracking' : 'Read-only account access'}</b><small className="t3">{PLATFORM_NAME[a.venue]} · {a.label} · sample data, last observed {a.lastObserved ? when(a.lastObserved) : '—'}</small></div>
            <Chip>Sample</Chip></div>
        ))}
        <div className="src-row"><span className="plat file" aria-hidden="true"><Icon name="download" size={13} /></span>
          <div><b>CSV import</b><small className="t3">{csv.length} active batch{csv.length === 1 ? '' : 'es'} across {new Set(csv.map((b) => b.accountId)).size} account{new Set(csv.map((b) => b.accountId)).size === 1 ? '' : 's'} · sample files</small></div>
          <Button size="sm" onClick={onImport}>Import…</Button></div>
        <div className="src-row"><span className="plat file" aria-hidden="true"><Icon name="edit" size={13} /></span>
          <div><b>Manual entry</b><small className="t3">{manual.length} manual record{manual.length === 1 ? '' : 's'} · can supplement any account</small></div>
          <Button size="sm" onClick={onManual}>Add record…</Button></div>
      </div>
    </Card>
    <Card id="add-source" flush>
      <CardHeader pad title="Add a source" sub="You choose which sources Scevia reads. It never places trades, moves funds, or asks for private keys or seed phrases." />
      <div className="src-list">
        <div className="src-row"><PlatformBadge p="pm" /><div><b>Track a Polymarket wallet</b><small className="t3">Read-only, by public address. An address identifies a wallet; it isn’t proof you own it.</small></div><Button size="sm" disabled title="Not available yet">Connect</Button></div>
        <div className="src-row"><PlatformBadge p="ks" /><div><b>Connect a Kalshi account</b><small className="t3">Read-only access, with your explicit consent.</small></div><Button size="sm" disabled title="Not available yet">Connect</Button></div>
      </div>
      <div className="foot"><span>Connections aren’t available yet. CSV import and manual entry work with the sample records.</span><span /></div>
    </Card>
  </>)
}

/* ── Transactions ─────────────────────────────────────────── */
function Transactions({ ws, commit }: { ws: Workspace; commit: (label: string, ws: Workspace) => void }) {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const f: R.RecordFilter = { ...R.NO_FILTER, ...Object.fromEntries(Object.keys(R.NO_FILTER).filter((k) => params.has(k)).map((k) => [k, k === 'duplicates' ? params.get(k) === '1' : params.get(k)])) } as R.RecordFilter
  const [page, setPage] = useState(0)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [cleared, setCleared] = useState(false)
  const [confirm, setConfirm] = useState<R.Action | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const rows = useMemo(() => R.filterRecords(ws.records, f, ws.accounts), [ws, JSON.stringify(f)]) // eslint-disable-line react-hooks/exhaustive-deps
  const dups = useMemo(() => R.duplicateCandidates(ws.records), [ws])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), pg = Math.min(page, pages - 1)
  const visible = rows.slice(pg * PAGE, pg * PAGE + PAGE)
  // Selection always belongs to the current results: changing filters clears it (and says so).
  const setFilter = (patch: Partial<R.RecordFilter>) => {
    const next = { ...f, ...patch }, p = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v !== (R.NO_FILTER as unknown as Record<string, unknown>)[k]) p.set(k, typeof v === 'boolean' ? '1' : String(v))
    setParams(p, { replace: true })
  }
  const fKey = JSON.stringify(f)
  const [lastF, setLastF] = useState(fKey)
  if (fKey !== lastF) { setLastF(fKey); setPage(0); if (sel.size) { setSel(new Set()); setCleared(true) } }
  const picked = [...sel].filter((k) => rows.some((r) => r.key === k))
  const allVisible = visible.length > 0 && visible.every((r) => sel.has(r.key)), allMatching = rows.length > 0 && rows.every((r) => sel.has(r.key))
  const toggle = (k: string, on: boolean) => { setCleared(false); setSel((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n }) }
  const active = JSON.stringify(f) !== JSON.stringify(R.NO_FILTER)
  return (<>
    <Card id="transactions" flush>
      <CardHeader pad title="Records" sub="Original records from each source with your decisions applied. Search here filters records; use ⌘K to find anything else." />
      <div className="rec-filters" role="search" aria-label="Filter records">
        <input className="text-input" type="search" placeholder="Search market, outcome, type, reference…" aria-label="Search records" value={f.q} onChange={(e) => setFilter({ q: e.target.value })} />
        <select className="select" aria-label="Account" value={f.account} onChange={(e) => setFilter({ account: e.target.value })}><option value="all">All accounts</option>{ws.accounts.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label}</option>)}</select>
        <select className="select" aria-label="Venue" value={f.venue} onChange={(e) => setFilter({ venue: e.target.value })}><option value="all">All venues</option><option value="pm">Polymarket</option><option value="ks">Kalshi</option></select>
        <select className="select" aria-label="Source" value={f.source} onChange={(e) => setFilter({ source: e.target.value })}><option value="all">All sources</option>{(Object.keys(SOURCE_LABEL) as (keyof typeof SOURCE_LABEL)[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select>
        <select className="select" aria-label="Type" value={f.type} onChange={(e) => setFilter({ type: e.target.value })}><option value="all">All types</option>{(Object.keys(R.TYPE_LABEL) as RecordType[]).map((t) => <option key={t} value={t}>{R.TYPE_LABEL[t]}</option>)}</select>
        <select className="select" aria-label="Status" value={f.status} onChange={(e) => setFilter({ status: e.target.value })}><option value="all">Any status</option>{(Object.keys(R.STATUS_LABEL) as R.Status[]).map((s) => <option key={s} value={s}>{R.STATUS_LABEL[s]}</option>)}<option value="corrected">Corrected</option><option value="adjusted">Any decision</option></select>
        {f.batch !== 'all' && <Chip>Batch {f.batch}</Chip>}
        <input className="text-input" type="date" aria-label="From date" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
        <input className="text-input" type="date" aria-label="To date" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
        <label className="check"><input type="checkbox" checked={f.duplicates} onChange={(e) => setFilter({ duplicates: e.target.checked })} />Potential duplicates</label>
        {active && <button type="button" className="link" onClick={() => setFilter(R.NO_FILTER)}>Clear filters</button>}
      </div>
      <div className="sel-scope" role="toolbar" aria-label="Selected records">
        {picked.length > 0 ? <>
          <b>{picked.length} selected</b><span className="t3">{allMatching ? `all ${rows.length} matching` : allVisible && picked.length === visible.length ? 'this page' : 'individually'}</span>
          {!allMatching && rows.length > visible.length && <button type="button" className="link" onClick={() => setSel(new Set(rows.map((r) => r.key)))}>Select all {rows.length} matching</button>}
          <button type="button" className="link" onClick={() => setSel(new Set())}>Clear selection</button>
          <span className="spacer" />
          {(['exclude', 'include', 'restore', 'distinct'] as R.Action[]).map((a) => <Button key={a} size="sm" variant={a === 'exclude' ? 'primary' : undefined} onClick={() => setConfirm(a)}>{R.ACTION_LABEL[a]}…</Button>)}
          <select className="select" aria-label="More actions" value="" onChange={(e) => e.target.value && setConfirm(e.target.value as R.Action)}>
            <option value="">More…</option>{(['reset_correction', 'reset_duplicate', 'reset_identity', 'reset_all'] as R.Action[]).map((a) => <option key={a} value={a}>{R.ACTION_LABEL[a]}…</option>)}</select>
        </> : <span className="t3">{cleared ? 'Selection cleared because the filters changed.' : `${rows.length} record${rows.length === 1 ? '' : 's'}${active ? ' match these filters' : ''}. Select records to change several at once.`}</span>}
      </div>
      <div className="dt-wrap">
        <table className="dt rec-table">
          <thead><tr>
            <th scope="col" className="rec-c"><input type="checkbox" aria-label="Select all records on this page" checked={allVisible} onChange={(e) => { setCleared(false); setSel((s) => { const n = new Set(s); visible.forEach((r) => (e.target.checked ? n.add(r.key) : n.delete(r.key))); return n }) }} /></th>
            <th scope="col">Date</th><th scope="col">Account</th><th scope="col">Type</th><th scope="col">Market · outcome</th><th scope="col" className="r">Qty</th><th scope="col" className="r">Price</th><th scope="col" className="r">Cash effect</th><th scope="col" className="r">Fee</th><th scope="col">Source</th><th scope="col">Status</th>
          </tr></thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={11}><div className="empty"><p>No records match these filters.</p>{active && <button type="button" className="link" onClick={() => setFilter(R.NO_FILTER)}>Clear filters</button>}</div></td></tr>}
            {visible.map((r) => {
              const e = R.effective(r), st = R.statusOf(r, ws.records), a = ws.accounts.find((x) => x.id === r.accountId), c = R.cashEffect(e)
              return (
                <tr key={r.key} className={cx((st === 'excluded' || st === 'duplicate') && 'excluded', sel.has(r.key) && 'is-sel')}>
                  <td className="rec-c"><input type="checkbox" checked={sel.has(r.key)} aria-label={`Select record ${r.key}`} onChange={(ev) => toggle(r.key, ev.target.checked)} /></td>
                  <td className="tnum">{when(e.time)}</td>
                  <td><span className="row">{a && <PlatformBadge p={a.venue} size={16} />}<span className="acct-name" title={a?.label}>{a?.label ?? 'Unknown account'}</span></span></td>
                  <td>{R.TYPE_LABEL[e.type]}</td>
                  <td className="mkt"><button type="button" className="link pb-link" onClick={() => setDetail(r.key)}>{e.instrument ?? R.TYPE_LABEL[e.type]}</button>{e.side && <small className="t3"> {e.side}</small>}{e.instrument && !e.marketId && <small className="t3"> · local</small>}</td>
                  <td className="r">{e.quantity == null ? '—' : qty(e.quantity)}</td>
                  <td className="r">{e.price == null ? '—' : e.price.toFixed(2)}</td>
                  <td className="r">{c == null ? <span className="stale">Unknown</span> : Math.abs(c) < 0.005 ? '$0' : sfmt(c, 2)}</td>
                  <td className="r">{e.type !== 'buy' && e.type !== 'sell' ? <span className="t3">—</span> : e.fee == null ? <span className="t3">not reported</span> : fmt(e.fee, 2)}</td>
                  <td className="t2">{SOURCE_LABEL[r.source]}</td>
                  <td className="rec-st"><span className="row">{st === 'review' ? <Chip tone="warn">Needs review</Chip> : st === 'included' ? <span className="t2">Included</span> : <Chip>{R.STATUS_LABEL[st]}</Chip>}{r.correction && <Chip tone="info">Corrected</Chip>}{dups[r.key] && !r.duplicateOf && !r.identity && st !== 'review' && <Chip tone="warn">Possible duplicate</Chip>}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="foot"><span>{rows.length} matching of {ws.records.length} records · page {pg + 1} of {pages}</span>
        <span className="row"><Button size="sm" variant="ghost" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</Button><Button size="sm" variant="ghost" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</Button></span></div>
    </Card>
    {confirm && <ConfirmBulk action={confirm} keys={picked} ws={ws} onCancel={() => setConfirm(null)}
      onConfirm={(p) => { commit(`${R.ACTION_LABEL[confirm]} · ${p.changed.length} record${p.changed.length === 1 ? '' : 's'}`, { ...ws, records: R.applyPreview(ws.records, p, confirm) }); setSel(new Set()); setConfirm(null); toast(`${R.ACTION_LABEL[confirm]}: ${p.changed.length} record${p.changed.length === 1 ? '' : 's'} changed`) }} />}
    {detail && ws.records.some((r) => r.key === detail) && <RecordDetail r={ws.records.find((x) => x.key === detail)!} ws={ws} dups={dups[detail] ?? []} onClose={() => setDetail(null)} onChange={(label, records) => { commit(label, { ...ws, records }); toast(label) }} />}
  </>)
}

function ConfirmBulk({ action, keys, ws, onCancel, onConfirm }: { action: R.Action; keys: string[]; ws: Workspace; onCancel: () => void; onConfirm: (p: R.Preview) => void }) {
  const p = R.preview(ws.records, keys, action)
  const cash = Object.entries(p.cash), q = Object.values(p.qty)
  return (
    <Modal title={`${R.ACTION_LABEL[action]}: ${keys.length} selected record${keys.length === 1 ? '' : 's'}?`} sub="Preview in this sample workspace" onClose={onCancel}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={p.changed.length === 0} onClick={() => onConfirm(p)}>{p.changed.length ? `${R.ACTION_LABEL[action]} · ${p.changed.length}` : 'Nothing to change'}</Button></>}>
      <p className="t2">{R.ACTION_HELP[action]}</p>
      <div className="effect">
        <div>Selected<b>{p.selected}</b></div><div>Will change<b>{p.changed.length}</b></div><div>Already in that state<b>{p.unchanged}</b></div>
        {p.indirect.length > 0 && <div>Also affected<b>{p.indirect.length}</b></div>}
        {p.unknown > 0 && <div>Unknown amounts<b className="warn-fg">{p.unknown}</b></div>}
      </div>
      {p.indirect.length > 0 && <Callout tone="warn" icon="alert"><b>{p.indirect.length} other record{p.indirect.length === 1 ? '' : 's'} change as a result</b> ({p.indirect.join(', ')}): {p.indirect.length === 1 ? 'it links' : 'they link'} to a selected record as a duplicate. No decision is applied to {p.indirect.length === 1 ? 'it' : 'them'}{p.toReview.some((k) => p.indirect.includes(k)) ? `; ${p.toReview.filter((k) => p.indirect.includes(k)).length} will need review` : ''}. Effects below include {p.indirect.length === 1 ? 'it' : 'them'}.</Callout>}
      <small className="t3">Accounts: {p.accounts.map((a) => acctName(ws, a)).join(', ')}</small>
      {(cash.length > 0 || q.length > 0) && <dl className="kv">
        {cash.map(([a, v]) => <Fragment key={a}><dt>Included cash · {acctName(ws, a)}</dt><dd>{sfmt(v, 2)}</dd></Fragment>)}
        {q.map((x) => <Fragment key={`${x.accountId}${x.label}`}><dt>Shares · {x.label} · {ws.accounts.find((a) => a.id === x.accountId)?.label}</dt><dd>{x.delta > 0 ? '+' : '−'}{qty(Math.abs(x.delta))}</dd></Fragment>)}
      </dl>}
      <small className="t3">Effects are the change in included cash and shares of these records only, not recalculated balances or P&amp;L.{p.unknown ? ' Records with unreported fees are counted separately, not as $0.' : ''}</small>
    </Modal>
  )
}

function RecordDetail({ r, ws, dups, onClose, onChange }: { r: R.ManagedRecord; ws: Workspace; dups: string[]; onClose: () => void; onChange: (label: string, records: R.ManagedRecord[]) => void }) {
  const e = R.effective(r), st = R.statusOf(r, ws.records)
  const [edit, setEdit] = useState<{ quantity: string; price: string; fee: string; unknownFee: boolean } | null>(null)
  const [dupTarget, setDupTarget] = useState(() => dups.find((k) => { const t = ws.records.find((x) => x.key === k); return t && !t.duplicateOf && R.statusOf(t, ws.records) === 'included' }) ?? '')
  const editable = r.source !== 'api', trade = e.type === 'buy' || e.type === 'sell'
  const parsed = edit && { q: parseShares(edit.quantity), p: parsePrice(edit.price), f: parseMoney(edit.fee) }
  const okEdit = parsed && (!trade || (parsed.q.state === 'ok' && parsed.p.state === 'ok')) && (edit!.unknownFee || parsed.f.state === 'ok')
  const cands = dups.map((k) => ws.records.find((x) => x.key === k)!).filter(Boolean)
  const run = (a: R.Action, label: string) => onChange(label, R.apply(ws.records, [r.key], a))
  return (
    <Drawer title={`${R.TYPE_LABEL[e.type]} · ${e.instrument ?? acctName(ws, r.accountId)}`} sub={`${r.key} · ${SOURCE_LABEL[r.source]}${r.batchId ? ` · batch ${r.batchId}` : ''}`} onClose={onClose}>
      <dl className="kv">
        <dt>Account</dt><dd>{acctName(ws, r.accountId)}</dd>
        <dt>Status</dt><dd>{R.STATUS_LABEL[st]}{st === 'review' && r.duplicateOf ? ` · ${linkProblem(r, ws.records)}` : ''}</dd>
        <dt>Membership</dt><dd>{r.membership ? `${r.membership === 'include' ? 'Included' : 'Excluded'} by you` : 'As delivered'}</dd>
        <dt>Identity</dt><dd>{r.identity === 'distinct' ? 'Accepted as a separate transaction' : r.duplicateOf ? `Duplicate of ${r.duplicateOf}` : '—'}</dd>
        <dt>Source reference</dt><dd className="mono-s">{r.sourceRef}</dd>
        <dt>Time</dt><dd>{when(e.time)}</dd>
        {e.instrument && <><dt>Market</dt><dd>{e.instrument} {e.side}{e.marketId ? '' : ' · local instrument (not matched to a catalog market)'}</dd></>}
        {e.quantity != null && <><dt>Quantity</dt><dd>{qty(e.quantity)}{r.correction?.quantity !== undefined && <small className="t3"> · originally {r.quantity == null ? '—' : qty(r.quantity)}</small>}</dd></>}
        {e.price != null && <><dt>Price</dt><dd>{e.price.toFixed(3)}{r.correction?.price !== undefined && <small className="t3"> · originally {r.price?.toFixed(3)}</small>}</dd></>}
        {e.amount != null && <><dt>Amount</dt><dd>{fmt(e.amount, 2)}</dd></>}
        {trade && <><dt>Fee</dt><dd>{e.fee == null ? 'Not reported (unknown, not $0)' : fmt(e.fee, 2)}{r.correction && 'fee' in r.correction && <small className="t3"> · originally {r.fee == null ? 'not reported' : fmt(r.fee, 2)}</small>}</dd></>}
        <dt>Cash effect</dt><dd>{R.cashEffect(e) == null ? 'Unknown' : sfmt(R.cashEffect(e)!, 2)}{e.type === 'settlement' ? ' · creates an entitlement; cash arrives with the redemption' : ''}</dd>
      </dl>
      {cands.length > 0 && !r.duplicateOf && r.identity !== 'distinct' && (
        <fieldset className="setup-f drawer-sec"><legend className="l">Possible duplicate of {cands.length > 1 ? `${cands.length} records` : 'another record'}</legend>
          <small className="t3">Same account, type and terms. It may be one transaction recorded twice, or two real identical trades.</small>
          {cands.map((c) => { const ce = R.effective(c), eligible = R.statusOf(c, ws.records) === 'included' && !c.duplicateOf; return (
            <label key={c.key} className={cx('choice', dupTarget === c.key && 'on')} style={eligible ? undefined : { opacity: 0.6 }} title={eligible ? undefined : 'Only an included record can be the original'}><input type="radio" name="dup" disabled={!eligible} checked={dupTarget === c.key} onChange={() => setDupTarget(c.key)} />
              <span>{c.key} · {SOURCE_LABEL[c.source]}{c.batchId ? ` · batch ${c.batchId}` : ''}<small>{when(ce.time)} · {ce.quantity != null ? `${qty(ce.quantity)} @ ${ce.price?.toFixed(2)}` : ce.amount != null ? fmt(ce.amount, 2) : '—'} · {R.STATUS_LABEL[R.statusOf(c, ws.records)]}</small></span></label>
          ) })}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button size="sm" disabled={!dupTarget} onClick={() => { const n = R.markDuplicate(ws.records, r.key, dupTarget); if (n) onChange(`Marked ${r.key} as a duplicate of ${dupTarget}`, n) }}>Duplicate of {dupTarget || '…'}</Button>
            <Button size="sm" onClick={() => run('distinct', `Kept ${r.key} as a separate transaction`)}>Separate transactions</Button>
          </div>
        </fieldset>
      )}
      <div className="drawer-actions" style={{ justifyContent: 'flex-start' }}>
        {st !== 'excluded' && <Button size="sm" onClick={() => run('exclude', `Excluded ${r.key}`)}>Exclude</Button>}
        {(st === 'excluded' || st === 'review') && <Button size="sm" onClick={() => run('include', `Included ${r.key}`)}>Include</Button>}
        {r.membership && <Button size="sm" variant="ghost" onClick={() => run('restore', `Restored membership of ${r.key}`)}>Restore membership</Button>}
        {r.duplicateOf && <Button size="sm" variant="ghost" onClick={() => run('reset_duplicate', `Removed duplicate link on ${r.key}`)}>Reset duplicate link</Button>}
        {r.identity && <Button size="sm" variant="ghost" onClick={() => run('reset_identity', `Reset identity decision on ${r.key}`)}>Reset identity decision</Button>}
        {editable && !edit && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ quantity: e.quantity == null ? '' : String(e.quantity), price: e.price == null ? '' : String(e.price), fee: e.fee == null ? '' : String(e.fee), unknownFee: e.fee == null })}>Correct values…</Button>}
        {r.correction && <Button size="sm" variant="ghost" onClick={() => run('reset_correction', `Reset correction on ${r.key}`)}>Reset correction</Button>}
      </div>
      {!editable && <small className="t3">Provider records can’t be edited: exclude them, or add a manual record to the same account.</small>}
      {edit && parsed && (
        <fieldset className="setup-f drawer-sec"><legend className="l">Correct this record <span className="t3">(original values are kept)</span></legend>
          {trade && <label className="add-field"><span className="l">Quantity</span><input className="num-input" inputMode="decimal" value={edit.quantity} aria-invalid={parsed.q.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, quantity: ev.target.value })} aria-label="Corrected quantity" /></label>}
          {trade && <label className="add-field"><span className="l">Price</span><input className="num-input" inputMode="decimal" value={edit.price} aria-invalid={parsed.p.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, price: ev.target.value })} aria-label="Corrected price" /></label>}
          {trade && <><label className="check"><input type="checkbox" checked={edit.unknownFee} onChange={(ev) => setEdit({ ...edit, unknownFee: ev.target.checked })} />Fee unknown</label>
            {!edit.unknownFee && <label className="add-field"><span className="l">Fee</span><input className="num-input" inputMode="decimal" value={edit.fee} aria-invalid={parsed.f.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, fee: ev.target.value })} aria-label="Corrected fee" /></label>}</>}
          <div className="row"><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!okEdit} onClick={() => {
              const v = (x: ReturnType<typeof parseShares>) => (x.state === 'ok' ? x.value : null)
              onChange(`Corrected ${r.key}`, R.correct(ws.records, r.key, trade ? { quantity: v(parsed.q), price: v(parsed.p), fee: edit.unknownFee ? null : v(parsed.f) } : {})); setEdit(null)
            }}>Save correction</Button></div>
        </fieldset>
      )}
    </Drawer>
  )
}

/* ── Imports & reconciliation ─────────────────────────────── */
function Imports({ ws, reviewCount, onImport }: { ws: Workspace; reviewCount: number; onImport: (file?: string, accountId?: string) => void }) {
  const nav = useNavigate()
  const dups = Object.keys(R.duplicateCandidates(ws.records)).filter((k) => { const r = ws.records.find((x) => x.key === k)!; return !r.duplicateOf && !r.identity }).length
  return (<>
    <div className="grid g-2 anchor" id="review">
      <Card><CardHeader title="Needs review" sub="Overlapping or unresolved rows that don’t count until you decide" />
        <div className="card-b"><div className="big-n">{reviewCount}</div><Button size="sm" disabled={!reviewCount} onClick={() => nav('/portfolio/transactions?status=review')}>Review records</Button></div></Card>
      <Card><CardHeader title="Possible duplicates" sub="Same account, type and terms; you decide whether they are one transaction" />
        <div className="card-b"><div className="big-n">{dups}</div><Button size="sm" disabled={!dups} onClick={() => nav('/portfolio/transactions?duplicates=1')}>Review duplicates</Button></div></Card>
    </div>
    <Card id="imports" flush>
      <CardHeader pad title="Import history" sub="Each import is a batch with its own identity. Importing a file again into the same account replaces it and carries your decisions." right={<Button size="sm" icon="download" onClick={() => onImport()}>Import CSV…</Button>} />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">File</th><th scope="col">Account</th><th scope="col">Relationship</th><th scope="col">Imported</th><th scope="col" className="r">Rows</th><th scope="col" className="r">Included</th><th scope="col" className="r">Review</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {ws.batches.length === 0 && <tr><td colSpan={9}><div className="empty"><p>No imports yet.</p></div></td></tr>}
          {[...ws.batches].reverse().map((b) => {
            const rs = ws.records.filter((r) => r.batchId === b.id)
            return (
              <tr key={b.id} className={cx(b.status === 'superseded' && 'excluded')}>
                <td><span className="mono-s">{b.file}</span><small className="t3 cell-sub">batch {b.id}{b.replaces ? ` · replaces ${b.replaces}` : ''}</small></td>
                <td>{acctName(ws, b.accountId)}</td><td>{b.mode === 'supplement' ? 'Supplements history' : 'Independent'}</td><td className="tnum">{when(b.importedAt)}</td>
                <td className="r">{b.rows}</td><td className="r">{b.status === 'active' ? rs.filter((r) => R.statusOf(r, ws.records) === 'included').length : '—'}</td>
                <td className="r">{b.status === 'active' ? rs.filter((r) => R.statusOf(r, ws.records) === 'review').length : '—'}</td>
                <td>{b.status === 'active' ? <span className="t2">Active</span> : <Chip>Superseded</Chip>}</td>
                <td className="r">{b.status === 'active' && <span className="row"><Button size="sm" variant="ghost" onClick={() => nav(`/portfolio/transactions?batch=${encodeURIComponent(b.id)}`)}>Records</Button>
                  {SAMPLE_FILES.some((f) => f.name === b.file) && <Button size="sm" variant="ghost" onClick={() => onImport(b.file, b.accountId)}>Replace…</Button>}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </Card>
  </>)
}

const STEPS = ['File', 'Account', 'Preview', 'Confirm', 'Result'] as const
function ImportFlow({ ws, preset, onClose, onDone }: { ws: Workspace; preset: { file?: string; accountId?: string }; onClose: () => void; onDone: (label: string, ws: Workspace, review: number, batchId: string) => void }) {
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(preset.file ?? SAMPLE_FILES[0].name)
  const [target, setTarget] = useState<string>(preset.accountId ?? 'pm-main')
  const [newLabel, setNewLabel] = useState('Wallet C'), [newVenue, setNewVenue] = useState<Platform>('pm')
  const [mode, setMode] = useState<R.ImportMode>(preset.accountId && preset.accountId !== 'pm-main' ? 'independent' : 'supplement')
  const [accept, setAccept] = useState(true)
  const [ids] = useState(() => ({ batch: newId('batch'), account: newId('acc') }))
  const [result, setResult] = useState<{ ws: Workspace; added: R.ManagedRecord[] } | null>(null)
  const sf = SAMPLE_FILES.find((x) => x.name === file)!
  const isNew = target === 'new', accountId = isNew ? ids.account : target
  const effMode: R.ImportMode = isNew ? 'independent' : mode
  const p = useMemo(() => R.previewImport(sf, accountId, effMode, ws.records, ws.batches, ids.batch), [sf, accountId, effMode, ws, ids.batch])
  const overlaps = p.rows.filter((r) => r.match).length, carried = p.rows.filter((r) => r.carried).length, feeUnknown = p.rows.filter((r) => r.warnings.includes('Fee not reported')).length
  const finish = () => {
    const accounts = isNew ? [...ws.accounts, { id: accountId, venue: newVenue, label: newLabel.trim(), kind: 'imported' as const, sources: ['csv' as const], openingDeclared: false, inAnalytics: false, lastObserved: null }]
      : ws.accounts.map((a) => (a.id === accountId && !a.sources.includes('csv') ? { ...a, sources: [...a.sources, 'csv' as const] } : a))
    const c = R.confirmImport(ws.records, ws.batches, p, accept, new Date().toISOString())
    setResult({ ws: { accounts, records: c.records, batches: c.batches }, added: c.added }); setStep(4)
  }
  const review = result ? result.added.filter((r) => R.statusOf(r, result.ws.records) === 'review').length : 0
  return (
    <Modal title="Import a CSV file" sub="Sample files only: nothing is read from your computer or uploaded" onClose={onClose} width={700}
      footer={<>{step > 0 && step < 4 && <Button variant="ghost" onClick={() => setStep(step - 1)}>Back</Button>}<span className="spacer" />
        {step < 3 && <Button variant="primary" disabled={step === 1 && isNew && !newLabel.trim()} onClick={() => setStep(step + 1)}>Continue</Button>}
        {step === 3 && <Button variant="primary" onClick={finish}>{p.replaces ? `Replace with ${p.rows.length} rows` : `Import ${p.rows.length} rows`}</Button>}
        {step === 4 && <Button variant="primary" onClick={() => onDone(`Imported ${sf.name} into ${isNew ? newLabel.trim() : ws.accounts.find((a) => a.id === accountId)?.label}`, result!.ws, review, p.batchId)}>Done</Button>}</>}>
      <ol className="steps" aria-label="Import steps">{STEPS.map((s, i) => <li key={s} className={cx(i === step && 'on', i < step && 'done')} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>
      {step === 0 && <fieldset className="add-list"><legend className="l">Choose a file</legend>
        {SAMPLE_FILES.map((x) => <label key={x.name} className={cx('choice', file === x.name && 'on')}><input type="radio" name="file" checked={file === x.name} onChange={() => setFile(x.name)} /><span>{x.name} <Chip>Sample file</Chip><small>{x.about} · {x.rows.length} rows</small></span></label>)}
        <small className="t3">Importing your own files needs a Scevia account, which isn’t available yet.</small></fieldset>}
      {step === 1 && <>
        <label className="add-field"><span className="l">Account these records belong to</span>
          <select className="select" style={{ maxWidth: 'none' }} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Account for import">
            {ws.accounts.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label} ({KIND_LABEL[a.kind].toLowerCase()})</option>)}
            <option value="new">New imported account…</option></select></label>
        {isNew ? <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="add-field"><span className="l">Venue</span><Seg label="Venue" options={['Polymarket', 'Kalshi'] as const} value={PLATFORM_NAME[newVenue] as 'Polymarket'} onChange={(v) => setNewVenue(v === 'Kalshi' ? 'ks' : 'pm')} /></label>
          <label className="add-field" style={{ flex: 1 }}><span className="l">Account name</span><input className="text-input" value={newLabel} maxLength={60} onChange={(e) => setNewLabel(e.target.value)} aria-label="New account name" /></label>
        </div> : (
          <fieldset className="setup-f"><legend className="l">How does this file relate to the account?</legend>
            <Seg label="Import relationship" options={['Supplements its history', 'Independent records'] as const} value={mode === 'supplement' ? 'Supplements its history' : 'Independent records'} onChange={(v) => setMode(v === 'Independent records' ? 'independent' : 'supplement')} />
            <small className="t3">{mode === 'supplement' ? 'Rows that exactly match records the account already has are flagged for review; nothing is merged automatically.' : 'Every row is added as its own record in this account, without overlap checks.'}</small></fieldset>
        )}
        {p.replaces && <Callout tone="warn" icon="alert">This file is already imported into this account (batch {p.replaces.id}). Continuing replaces that batch; your decisions carry over to matching rows.</Callout>}
        {isNew && <small className="t3">A new imported account is independent: its records aren’t matched against other accounts, even on the same venue.</small>}
      </>}
      {step === 2 && <>
        <div className="effect"><div>Rows<b>{p.rows.length}</b></div><div>Overlap with existing<b>{overlaps}</b></div><div>Fees not reported<b>{feeUnknown}</b></div>{p.replaces && <div>Decisions carried<b>{carried}</b></div>}</div>
        <div className="dt-wrap"><table className="dt"><thead><tr><th scope="col">#</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Market</th><th scope="col" className="r">Qty</th><th scope="col" className="r">Price / amount</th><th scope="col">Notes</th></tr></thead>
          <tbody>{p.rows.map((x) => <tr key={x.n}><td>{x.n}</td><td className="tnum">{when(x.rec.time)}</td><td>{R.TYPE_LABEL[x.rec.type]}</td><td>{x.rec.instrument ? `${x.rec.instrument} ${x.rec.side}` : '—'}</td><td className="r">{x.rec.quantity == null ? '—' : qty(x.rec.quantity)}</td><td className="r">{x.rec.price != null ? x.rec.price.toFixed(2) : x.rec.amount != null ? fmt(x.rec.amount, 2) : '—'}</td><td>{x.warnings.length ? <span className="stale">{x.warnings.join(' · ')}</span> : <span className="t3">—</span>}</td></tr>)}</tbody></table></div>
      </>}
      {step === 3 && <>
        <p className="t2">{effMode === 'independent' ? `All ${p.rows.length} rows will be added to ${isNew ? newLabel.trim() : acctName(ws, accountId)} as its own records.` : `${overlaps} overlapping row${overlaps === 1 ? '' : 's'} will wait for your review (duplicate or separate). ${p.rows.length - overlaps} row${p.rows.length - overlaps === 1 ? ' has' : 's have'} no match.`}</p>
        {effMode === 'supplement' && p.rows.length - overlaps > 0 && <label className="choice"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /><span>Include the {p.rows.length - overlaps} rows without a match<small>Otherwise they also wait for review. You can change any row later.</small></span></label>}
        {p.replaces && <small className="t3">Batch {p.replaces.id} will be marked superseded and kept in the import history.</small>}
      </>}
      {step === 4 && result && <>
        <div className="effect"><div>Imported<b>{result.added.length}</b></div><div>Included<b>{result.added.filter((r) => R.statusOf(r, result.ws.records) === 'included').length}</b></div><div>Waiting for review<b>{review}</b></div></div>
        <small className="t3">{review ? 'Done opens the rows waiting for review.' : 'Done opens the import history.'}</small>
      </>}
    </Modal>
  )
}

/* ── Manual records ───────────────────────────────────────── */
const CATALOG = SAMPLE_MARKET_EVENTS.flatMap((e) => e.markets.map((m) => ({ id: m.marketId, title: m.marketTitle, venue: e.provider })))
function ManualRecord({ ws, preset, onClose, onAdd }: { ws: Workspace; preset: string; onClose: () => void; onAdd: (ws: Workspace, label: string) => void }) {
  const [acct, setAcct] = useState(preset && ws.accounts.some((a) => a.id === preset) ? preset : ws.accounts[0]?.id ?? 'new')
  const [newLabel, setNewLabel] = useState('Manual records'), [newVenue, setNewVenue] = useState<Platform>('pm')
  const venue = acct === 'new' ? newVenue : ws.accounts.find((a) => a.id === acct)?.venue ?? 'pm'
  const [type, setType] = useState<RecordType>('buy')
  const [when_, setWhen] = useState('2026-11-20T12:00')
  const [mkMode, setMkMode] = useState<'Catalog market' | 'Local name'>('Catalog market')
  const [marketId, setMarketId] = useState(''), [local, setLocal] = useState('')
  const [outcome, setOutcome] = useState<Outcome | ''>('')
  const [q, setQ] = useState(''), [p, setP] = useState(''), [amt, setAmt] = useState(''), [fee, setFee] = useState('0'), [feeUnknown, setFeeUnknown] = useState(false)
  const [newId_] = useState(() => ({ acc: newId('acc'), rec: newId('manual') }))
  const trade = type === 'buy' || type === 'sell'
  const markets = CATALOG.filter((m) => m.venue === venue)
  const pq = parseShares(q), pp = parsePrice(p), pa = parseMoney(amt), pf = parseMoney(fee)
  const instrument = mkMode === 'Catalog market' ? markets.find((m) => m.id === marketId)?.title ?? '' : local.trim()
  const errs = [
    !when_ || Number.isNaN(Date.parse(`${when_}:00Z`)) ? 'Enter a date and time' : '',
    acct === 'new' && !newLabel.trim() ? 'Name the new account' : '',
    trade && !instrument ? 'Choose a market' : '', trade && !outcome ? 'Choose an outcome' : '',
    trade && pq.state !== 'ok' ? 'Enter a quantity' : '', trade && pp.state !== 'ok' ? 'Enter a price between 0.01 and 0.99' : '',
    trade && pp.state === 'ok' && (pp.value < 0.01 || pp.value > 0.99) ? 'Enter a price between 0.01 and 0.99' : '',
    !trade && pa.state !== 'ok' ? 'Enter an amount' : '', trade && !feeUnknown && pf.state !== 'ok' ? 'Enter the fee, or mark it unknown' : '',
  ].filter(Boolean)
  const add = () => {
    const accounts = acct === 'new' ? [...ws.accounts, { id: newId_.acc, venue: newVenue, label: newLabel.trim(), kind: 'manual' as const, sources: ['manual' as const], openingDeclared: false, inAnalytics: false, lastObserved: null }] : ws.accounts.map((a) => (a.id === acct && !a.sources.includes('manual') ? { ...a, sources: [...a.sources, 'manual' as const] } : a))
    const accountId = acct === 'new' ? newId_.acc : acct
    const rec: FinRecord = { key: newId_.rec, accountId, source: 'manual', batchId: null, sourceRef: newId_.rec, time: new Date(`${when_}:00Z`).toISOString(), type,
      instrument: trade ? instrument : null, marketId: trade && mkMode === 'Catalog market' ? marketId : null, side: trade ? (outcome as Outcome) : null,
      quantity: trade && pq.state === 'ok' ? pq.value : null, price: trade && pp.state === 'ok' ? pp.value : null, amount: !trade && pa.state === 'ok' ? pa.value : null,
      fee: trade ? (feeUnknown || pf.state !== 'ok' ? null : pf.value) : null }
    onAdd({ ...ws, accounts, records: [...ws.records, ...R.fromRecords([rec])] }, `Added a manual ${R.TYPE_LABEL[type].toLowerCase()} to ${acct === 'new' ? newLabel.trim() : ws.accounts.find((a) => a.id === acct)?.label}`)
  }
  return (
    <Modal title="Add a record" sub="A manual record supplements any account, including a connected one" onClose={onClose} width={560}
      footer={<><small className="t3" style={{ marginRight: 'auto' }}>{errs[0] ?? ''}</small><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={errs.length > 0} onClick={add}>Add record</Button></>}>
      <label className="add-field"><span className="l">Account</span><select data-autofocus className="select" style={{ maxWidth: 'none' }} value={acct} onChange={(e) => { setAcct(e.target.value); setMarketId('') }} aria-label="Record account">{ws.accounts.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label}</option>)}<option value="new">New manual account…</option></select></label>
      {acct === 'new' && <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="add-field"><span className="l">Venue</span><Seg label="Venue" options={['Polymarket', 'Kalshi'] as const} value={PLATFORM_NAME[newVenue] as 'Polymarket'} onChange={(v) => { setNewVenue(v === 'Kalshi' ? 'ks' : 'pm'); setMarketId('') }} /></label>
        <label className="add-field" style={{ flex: 1 }}><span className="l">Account name</span><input className="text-input" value={newLabel} maxLength={60} onChange={(e) => setNewLabel(e.target.value)} aria-label="New account name" /></label></div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="add-field"><span className="l">Type</span><select className="select" value={type} onChange={(e) => setType(e.target.value as RecordType)} aria-label="Record type">{(['buy', 'sell', 'deposit', 'withdrawal', 'fee'] as RecordType[]).map((t) => <option key={t} value={t}>{R.TYPE_LABEL[t]}</option>)}</select></label>
        <label className="add-field"><span className="l">Date and time (UTC)</span><input className="text-input" type="datetime-local" value={when_} onChange={(e) => setWhen(e.target.value)} aria-label="Record date and time" /></label>
      </div>
      {trade ? <>
        <Seg label="Market source" options={['Catalog market', 'Local name'] as const} value={mkMode} onChange={setMkMode} />
        {mkMode === 'Catalog market'
          ? <label className="add-field"><span className="l">Market ({PLATFORM_NAME[venue]}, sample catalog)</span><select className="select" style={{ maxWidth: 'none' }} value={marketId} onChange={(e) => setMarketId(e.target.value)} aria-label="Market"><option value="">Choose a market…</option>{markets.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
          : <label className="add-field"><span className="l">Market name (local instrument, not matched to a venue market)</span><input className="text-input" value={local} maxLength={120} onChange={(e) => setLocal(e.target.value)} aria-label="Local market name" /></label>}
        <fieldset className="setup-f"><legend className="l">Outcome</legend><Seg label="Outcome" options={['YES', 'NO'] as const} value={(outcome || 'none') as 'YES'} onChange={(v) => setOutcome(v)} /></fieldset>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="add-field"><span className="l">Quantity</span><input className="num-input" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quantity" aria-invalid={pq.state === 'invalid'} /></label>
          <label className="add-field"><span className="l">Price</span><input className="num-input" inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} aria-label="Price" aria-invalid={pp.state === 'invalid'} /></label>
          <label className="add-field"><span className="l">Fee</span><input className="num-input" inputMode="decimal" value={feeUnknown ? '' : fee} disabled={feeUnknown} onChange={(e) => setFee(e.target.value)} aria-label="Fee" aria-invalid={!feeUnknown && pf.state === 'invalid'} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={feeUnknown} onChange={(e) => setFeeUnknown(e.target.checked)} />Fee unknown (kept as unknown, not $0)</label>
      </> : <label className="add-field"><span className="l">Amount</span><input className="num-input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" aria-invalid={pa.state === 'invalid'} /></label>}
    </Modal>
  )
}

/* ── Data coverage ────────────────────────────────────────── */
function Coverage({ ws }: { ws: Workspace }) {
  const a = account('all')
  const est = ws.records.filter((r) => R.statusOf(r, ws.records) === 'included' && R.cashEffect(R.effective(r)) == null).length
  const review = ws.records.filter((r) => R.statusOf(r, ws.records) === 'review').length
  return (<>
    <Card id="coverage" flush>
      <CardHeader pad title="Sample portfolio" sub={`What Overview, Analytics and Risk are based on · history from ${fmtDate(HISTORY_START, { month: 'short', day: 'numeric', year: 'numeric' })}`} />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Account</th><th scope="col">Source</th><th scope="col">Observed</th><th scope="col" className="r">Open positions</th><th scope="col" className="r">Fills</th><th scope="col" className="r">Settlements</th><th scope="col" className="r">Estimated fees</th><th scope="col">Opening state</th></tr></thead>
        <tbody>{ws.accounts.filter((x) => x.inAnalytics).map((x) => { const c = coverage(x.venue), s = sourceOf(x.venue); return (
          <tr key={x.id}><td><span className="row"><PlatformBadge p={x.venue} size={16} />{x.label}</span></td><td>{x.connection ?? SOURCE_LABEL[x.sources[0]]}</td>
            <td className={cx(s.stale ? 'stale' : 't2')}>{fmtDate(s.asOf)}{s.stale ? ' · stale' : ''}</td><td className="r">{c.open}</td><td className="r">{c.fills}</td><td className="r">{c.settlements}</td>
            <td className={cx('r', c.feeEstimates > 0 && 'warn-fg')}>{c.feeEstimates}</td><td>{x.openingDeclared ? 'Declared' : 'Unknown'}</td></tr>) })}</tbody>
      </table></div>
      <div className="foot"><span>Figures are reconstructed from the sample records at {fmtDate(TODAY)} marks; value {fmt(a.totalValue)}. Estimated fees are labelled where they’re used.</span><span /></div>
    </Card>
    <div className="grid g-2">
      <Card><CardHeader title="How values are labelled" sub="The same states are used wherever a figure appears" />
        <div className="card-b"><dl className="kv">
          <dt>Known</dt><dd>From complete source records.</dd>
          <dt>Estimated</dt><dd>A source didn’t report it (e.g. a fee); shown as an estimate and counted.</dd>
          <dt>Provider-reported</dt><dd>As the venue reports it, before your decisions.</dd>
          <dt>Reconstructed</dt><dd>Derived from records with your decisions applied.</dd>
          <dt>Partial</dt><dd>Some components are known; the total isn’t complete.</dd>
          <dt>Stale</dt><dd>The source’s latest observation is older than 24 hours.</dd>
          <dt>Unavailable</dt><dd>Can’t be computed honestly; never shown as $0.</dd>
        </dl></div></Card>
      <Card><CardHeader title="Record-management sample" sub="The sample records in Transactions and Imports" />
        <div className="card-b"><div className="cov-mini"><div><b>{ws.records.length}</b>records</div><div><b>{ws.batches.filter((b) => b.status === 'active').length}</b>active imports</div><div><b className={cx(est > 0 && 'warn-fg')}>{est}</b>included with unknown amounts</div><div><b className={cx(review > 0 && 'warn-fg')}>{review}</b>need review</div></div>
          <p className="t3 chart-note">These records don’t feed the figures above. With a Scevia account, coverage, discrepancies and provider-reported vs. reconstructed values will come from your own records. <Link to="/portfolio/imports">Imports & reconciliation →</Link></p></div></Card>
    </div>
  </>)
}

/** Why a duplicate link doesn't hold (shown on a record that needs review). */
function linkProblem(r: R.ManagedRecord, all: R.ManagedRecord[]) {
  const t = all.find((x) => x.key === r.duplicateOf)
  if (!t) return `its original (${r.duplicateOf}) no longer exists`
  if (t.duplicateOf) return `its original (${t.key}) is itself marked as a duplicate`
  const st = R.statusOf(t, all)
  if (st !== 'included') return `its original (${t.key}) is ${R.STATUS_LABEL[st].toLowerCase()}`
  return `its original (${t.key}) has changed since you linked it`
}
