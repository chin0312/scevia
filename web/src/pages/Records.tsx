/* Accounts & records: which accounts and sources make up the portfolio, and the records behind them.
   A sample workspace: records and decisions here are illustrative, stay in this browser tab, and never change the
   figures in Overview, Analytics, Risk or Scenario Lab. Real imports and corrections need the backend accounting
   API (not connected in this build). Every decision is reversible; nothing deletes source data. */
import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Drawer, Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, Seg, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import { SAMPLE_ACCOUNTS, SAMPLE_FILES, SAMPLE_RECORDS, type FinRecord, type RecordType, type WorkspaceAccount } from '../data/sampleRecords'
import { fmt, qty, sfmt } from '../lib/format'
import { parseMoney, parsePrice, parseShares } from '../lib/inputs'
import * as R from '../lib/records'
import { useSessionState } from '../lib/useSessionState'

const PAGE = 10
const SOURCE_LABEL = { api: 'API sync', csv: 'CSV import', manual: 'Manual' } as const
const KIND_LABEL = { connected: 'Connected', imported: 'Imported', manual: 'Manual' } as const
const INCL_LABEL: Record<R.Inclusion, string> = { included: 'Included', excluded: 'Excluded', review: 'Needs review' }
const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

interface Workspace { accounts: WorkspaceAccount[]; records: R.ManagedRecord[] }
const INITIAL: Workspace = { accounts: SAMPLE_ACCOUNTS, records: R.fromRecords(SAMPLE_RECORDS) }
const valid = (v: unknown): v is Workspace => !!v && typeof v === 'object' && Array.isArray((v as Workspace).accounts) && Array.isArray((v as Workspace).records)

export default function Records() {
  useHashScroll()
  const toast = useToast()
  const [ws, setWs] = useSessionState<Workspace>('scevia-records-v1', INITIAL, (v) => (valid(v) ? v : null))
  const [history, setHistory] = useState<{ label: string; ws: Workspace }[]>([])
  const [f, setF] = useState<R.RecordFilter>(R.NO_FILTER)
  const [page, setPage] = useState(0)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<R.Action | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [manual, setManual] = useState(false)

  const rows = useMemo(() => R.filterRecords(ws.records, f, ws.accounts), [ws, f])
  const dups = useMemo(() => R.duplicateCandidates(ws.records), [ws])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), pg = Math.min(page, pages - 1)
  const visible = rows.slice(pg * PAGE, pg * PAGE + PAGE)
  const picked = [...sel].filter((k) => ws.records.some((r) => r.key === k))
  const commit = (label: string, next: Workspace) => { setHistory((h) => [...h.slice(-9), { label, ws }]); setWs(next) }
  const undo = () => { const last = history.at(-1); if (!last) return; setWs(last.ws); setHistory((h) => h.slice(0, -1)); toast(`Undid: ${last.label}`, 'info') }
  const setFilter = (patch: Partial<R.RecordFilter>) => { setF((x) => ({ ...x, ...patch })); setPage(0) }
  const acct = (id: string) => ws.accounts.find((a) => a.id === id)
  const allVisible = visible.length > 0 && visible.every((r) => sel.has(r.key))
  const allMatching = rows.length > 0 && rows.every((r) => sel.has(r.key))
  const counts = { review: ws.records.filter((r) => R.inclusionOf(r) === 'review').length, dups: Object.keys(dups).length }

  return (
    <div className="shell">
      <SectionRail sections={[{ id: 'accounts', label: 'Accounts', icon: 'db', count: ws.accounts.length }, { id: 'records', label: 'Records', icon: 'list', count: ws.records.length, flag: counts.review || undefined }]}>
        <div className="rail-card"><b>Sample workspace</b>Changes stay in this tab and don’t affect your portfolio figures.</div>
      </SectionRail>
      <main>
        <section className="page-head anchor" id="summary">
          <div><div className="caps"><span className="accent">Workspace</span> · sample records</div><h1>Accounts & records</h1></div>
          <div className="actions">
            <Button icon="download" onClick={() => setImporting(true)}>Import CSV…</Button>
            <Button icon="plus" onClick={() => setManual(true)}>Add manual record…</Button>
          </div>
        </section>
        <Callout icon="shield"><b>Sample workspace.</b> These accounts and records are fictional and separate from the sample portfolio: including, excluding or correcting them here doesn’t change Overview, Analytics, Risk or Scenario Lab, and nothing is uploaded or saved to an account. <Link to="/overview">Back to Overview</Link></Callout>

        <Card id="accounts">
          <CardHeader title="Accounts" sub="One account per wallet or venue login. Several can share a venue; one account can have several sources." info="A venue (Polymarket, Kalshi) is where positions are held. An account is one wallet or login there. A source (API sync, CSV file, manual entry) is how its records arrive. Being connected doesn’t mean the history is complete." />
          <div className="card-b acct-grid">
            {ws.accounts.map((a) => {
              const rs = ws.records.filter((r) => r.accountId === a.id), times = rs.map((r) => R.effective(r).time).sort()
              const unknownFees = rs.filter((r) => R.inclusionOf(r) === 'included' && R.cashEffect(R.effective(r)) == null).length, review = rs.filter((r) => R.inclusionOf(r) === 'review').length
              return (
                <div className="acct-card" key={a.id}>
                  <div className="row"><PlatformBadge p={a.venue} size={20} /><b>{PLATFORM_NAME[a.venue]} · {a.label}</b><Chip tone={a.kind === 'connected' ? 'info' : undefined}>{KIND_LABEL[a.kind]}</Chip></div>
                  <small className="t3">Sources: {[...new Set([...a.sources, ...rs.map((r) => r.source)])].map((s) => SOURCE_LABEL[s]).join(' + ')}{a.connection ? ` · ${a.connection}` : ''}</small>
                  <small className="t2">{rs.length} records{times.length ? ` · ${when(times[0])} – ${when(times.at(-1)!)}` : ''}</small>
                  <small className={cx(a.openingDeclared ? 't3' : 'stale')}>{a.openingDeclared ? 'Opening balance declared' : 'Opening balance unknown: cash before the first record is unknown'}</small>
                  {(unknownFees > 0 || review > 0) && <small className="stale">{[unknownFees ? `${unknownFees} with unknown fees` : '', review ? `${review} need review` : ''].filter(Boolean).join(' · ')}</small>}
                  <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setFilter({ ...R.NO_FILTER, account: a.id })}>Show records</button>
                </div>
              )
            })}
          </div>
        </Card>

        <Card id="records" flush>
          <CardHeader pad title="Records" sub="Original records from each source, with your decisions applied. Excluding never deletes the source record."
            right={<div className="row">{counts.review > 0 && <Button size="sm" onClick={() => setFilter({ ...R.NO_FILTER, inclusion: 'review' })}>{counts.review} need review</Button>}{counts.dups > 0 && <Button size="sm" onClick={() => setFilter({ ...R.NO_FILTER, duplicates: true })}>Potential duplicates</Button>}</div>} />
          <div className="rec-filters" role="search" aria-label="Filter records">
            <input className="text-input" type="search" placeholder="Search market, type, batch…" aria-label="Search records" value={f.q} onChange={(e) => setFilter({ q: e.target.value })} />
            <select className="select" aria-label="Account" value={f.account} onChange={(e) => setFilter({ account: e.target.value })}><option value="all">All accounts</option>{ws.accounts.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label}</option>)}</select>
            <select className="select" aria-label="Venue" value={f.venue} onChange={(e) => setFilter({ venue: e.target.value })}><option value="all">All venues</option><option value="pm">Polymarket</option><option value="ks">Kalshi</option></select>
            <select className="select" aria-label="Source" value={f.source} onChange={(e) => setFilter({ source: e.target.value })}><option value="all">All sources</option>{(Object.keys(SOURCE_LABEL) as (keyof typeof SOURCE_LABEL)[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select>
            <select className="select" aria-label="Type" value={f.type} onChange={(e) => setFilter({ type: e.target.value })}><option value="all">All types</option>{(Object.keys(R.TYPE_LABEL) as RecordType[]).map((t) => <option key={t} value={t}>{R.TYPE_LABEL[t]}</option>)}</select>
            <select className="select" aria-label="Inclusion" value={f.inclusion} onChange={(e) => setFilter({ inclusion: e.target.value })}><option value="all">Any status</option><option value="included">Included</option><option value="excluded">Excluded</option><option value="review">Needs review</option><option value="corrected">Corrected</option></select>
            <input className="text-input" type="date" aria-label="From date" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
            <input className="text-input" type="date" aria-label="To date" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
            <label className="check"><input type="checkbox" checked={f.duplicates} onChange={(e) => setFilter({ duplicates: e.target.checked })} />Potential duplicates</label>
            {JSON.stringify(f) !== JSON.stringify(R.NO_FILTER) && <button type="button" className="link" onClick={() => setFilter(R.NO_FILTER)}>Clear filters</button>}
          </div>
          {(picked.length > 0 || history.length > 0) && (
            <div className="sel-scope" role="toolbar" aria-label="Selected records">
              {picked.length > 0 ? <>
                <b>{picked.length} selected</b>
                {!allMatching && rows.length > visible.length && <button type="button" className="link" onClick={() => setSel(new Set(rows.map((r) => r.key)))}>Select all {rows.length} matching</button>}
                <button type="button" className="link" onClick={() => setSel(new Set())}>Clear selection</button>
                <span className="spacer" />
                {(['exclude', 'include', 'distinct', 'restore'] as R.Action[]).map((a) => <Button key={a} size="sm" variant={a === 'exclude' ? 'primary' : undefined} onClick={() => setConfirm(a)}>{R.ACTION_LABEL[a]}…</Button>)}
              </> : <span className="t3">No records selected.</span>}
              {history.length > 0 && <button type="button" className="link" onClick={undo}>Undo: {history.at(-1)!.label}</button>}
            </div>
          )}
          <div className="dt-wrap">
            <table className="dt rec-table">
              <thead><tr>
                <th scope="col" className="rec-c"><input type="checkbox" aria-label="Select all records on this page" checked={allVisible} onChange={(e) => setSel((s) => { const n = new Set(s); visible.forEach((r) => (e.target.checked ? n.add(r.key) : n.delete(r.key))); return n })} /></th>
                <th scope="col">Date</th><th scope="col">Account</th><th scope="col">Type</th><th scope="col">Market</th><th scope="col" className="r">Qty</th><th scope="col" className="r">Price</th><th scope="col" className="r">Cash effect</th><th scope="col" className="r">Fee</th><th scope="col">Source</th><th scope="col">Status</th>
              </tr></thead>
              <tbody>
                {visible.length === 0 && <tr><td colSpan={11}><div className="empty"><p>No records match these filters.</p></div></td></tr>}
                {visible.map((r) => {
                  const e = R.effective(r), inc = R.inclusionOf(r), a = acct(r.accountId), c = R.cashEffect(e)
                  return (
                    <tr key={r.key} className={cx(inc === 'excluded' && 'excluded', sel.has(r.key) && 'is-sel')}>
                      <td className="rec-c"><input type="checkbox" checked={sel.has(r.key)} aria-label={`Select record ${r.key}`} onChange={(ev) => setSel((s) => { const n = new Set(s); if (ev.target.checked) n.add(r.key); else n.delete(r.key); return n })} /></td>
                      <td className="tnum">{when(e.time)}</td>
                      <td><span className="row">{a && <PlatformBadge p={a.venue} size={16} />}{a?.label ?? r.accountId}</span></td>
                      <td>{R.TYPE_LABEL[e.type]}</td>
                      <td className="mkt"><button type="button" className="link pb-link" onClick={() => setDetail(r.key)}>{e.instrument ?? '—'}</button>{e.side && <small className="t3"> {e.side}</small>}</td>
                      <td className="r">{e.quantity == null ? '—' : qty(e.quantity)}</td>
                      <td className="r">{e.price == null ? '—' : e.price.toFixed(2)}</td>
                      <td className="r">{c == null ? <span className="stale">Unknown</span> : Math.abs(c) < 0.005 ? '$0' : sfmt(c, 2)}</td>
                      <td className="r">{e.type === 'fee' || e.type === 'deposit' || e.type === 'withdrawal' ? <span className="t3">—</span> : e.fee == null ? <span className="t3">not reported</span> : fmt(e.fee, 2)}</td>
                      <td className="t2">{SOURCE_LABEL[r.source]}</td>
                      <td className="rec-st"><span className="row">{inc === 'review' ? <Chip tone="warn">Needs review</Chip> : inc === 'excluded' ? <Chip>{r.decision?.kind === 'duplicate' ? 'Duplicate' : 'Excluded'}</Chip> : <span className="t2">Included</span>}{r.correction && <Chip tone="info">Corrected</Chip>}{dups[r.key] && !r.decision && <Chip tone="warn">Possible duplicate</Chip>}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="foot"><span>{rows.length} matching of {ws.records.length} records · page {pg + 1} of {pages}</span>
            <span className="row"><Button size="sm" variant="ghost" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</Button><Button size="sm" variant="ghost" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</Button></span></div>
        </Card>
        <div className="footer-note"><span>Record management mirrors the planned backend workflow: original evidence stays inspectable, and decisions are reversible.</span><span>Sample workspace</span></div>
      </main>

      {confirm && <ConfirmBulk action={confirm} keys={picked} ws={ws} onCancel={() => setConfirm(null)}
        onConfirm={(p) => { commit(`${R.ACTION_LABEL[confirm]} ${p.changed.length} record${p.changed.length === 1 ? '' : 's'}`, { ...ws, records: R.apply(ws.records, p.changed, confirm) }); setSel(new Set()); setConfirm(null); toast(`${R.ACTION_LABEL[confirm]}: ${p.changed.length} record${p.changed.length === 1 ? '' : 's'} updated`) }} />}
      {detail && <RecordDetail r={ws.records.find((x) => x.key === detail)!} ws={ws} dups={dups[detail] ?? []} onClose={() => setDetail(null)}
        onChange={(label, records) => { commit(label, { ...ws, records }); toast(label) }} />}
      {importing && <ImportFlow ws={ws} onClose={() => setImporting(false)} onDone={(label, next) => { commit(label, next); setImporting(false); setFilter({ ...R.NO_FILTER }) }} />}
      {manual && <ManualRecord ws={ws} onClose={() => setManual(false)} onAdd={(next, label) => { commit(label, next); setManual(false); toast(label) }} />}
    </div>
  )
}

function Effect({ p }: { p: R.Preview }) {
  const cash = Object.entries(p.cash), q = Object.entries(p.qty)
  return (<>
    <div className="effect">
      <div>Records changing state<b>{p.changed.length}</b></div>
      <div>Unchanged (already in that state)<b>{p.unchanged}</b></div>
      {p.unknown > 0 && <div>With unknown amounts<b className="warn-fg">{p.unknown}</b></div>}
    </div>
    {(cash.length > 0 || q.length > 0) && <dl className="kv">
      {cash.map(([a, v]) => <Fragment key={a}><dt>Cash · {SAMPLE_ACCOUNTS.find((x) => x.id === a)?.label ?? a}</dt><dd>{sfmt(v, 2)}</dd></Fragment>)}
      {q.map(([k, v]) => <Fragment key={k}><dt>Shares · {k}</dt><dd>{v > 0 ? '+' : '−'}{qty(Math.abs(v))}</dd></Fragment>)}
    </dl>}
  </>)
}

function ConfirmBulk({ action, keys, ws, onCancel, onConfirm }: { action: R.Action; keys: string[]; ws: Workspace; onCancel: () => void; onConfirm: (p: R.Preview) => void }) {
  const p = R.preview(ws.records, keys, action)
  const what = { exclude: 'Excluded records stay visible and can be restored; the source data isn’t deleted.', include: 'Included records count in this account’s records.', restore: 'Restore returns each record to how its source delivered it, removing your decision (corrections are kept).', distinct: 'Accepting as distinct keeps records that looked like overlaps as separate transactions.' }[action]
  return (
    <Modal title={`${R.ACTION_LABEL[action]} ${keys.length} selected record${keys.length === 1 ? '' : 's'}?`} sub="Preview of the change in this sample workspace" onClose={onCancel}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={p.changed.length === 0} onClick={() => onConfirm(p)}>{p.changed.length ? `${R.ACTION_LABEL[action]} ${p.changed.length}` : 'Nothing to change'}</Button></>}>
      <p className="t2">{what}</p>
      <Effect p={p} />
      <small className="t3">Effects are the change in included cash and shares of the selected records only. They aren’t recalculated balances or P&amp;L.</small>
    </Modal>
  )
}

function RecordDetail({ r, ws, dups, onClose, onChange }: { r: R.ManagedRecord; ws: Workspace; dups: string[]; onClose: () => void; onChange: (label: string, records: R.ManagedRecord[]) => void }) {
  const e = R.effective(r), a = ws.accounts.find((x) => x.id === r.accountId)
  const [edit, setEdit] = useState<{ quantity: string; price: string; fee: string } | null>(null)
  const inc = R.inclusionOf(r)
  const editable = r.source !== 'api'
  const parsed = edit && { q: parseShares(edit.quantity), p: parsePrice(edit.price), f: parseMoney(edit.fee) }
  const okEdit = parsed && (['q', 'p', 'f'] as const).every((k) => parsed[k].state === 'ok' || parsed[k].state === 'empty')
  return (
    <Drawer title={`${R.TYPE_LABEL[e.type]} · ${e.instrument ?? (a ? `${PLATFORM_NAME[a.venue]} ${a.label}` : '')}`} sub={`${r.key} · ${SOURCE_LABEL[r.source]}${r.batch ? ` · ${r.batch}` : ''}`} onClose={onClose}>
      <dl className="kv">
        <dt>Account</dt><dd>{a ? `${PLATFORM_NAME[a.venue]} · ${a.label}` : r.accountId}</dd>
        <dt>Status</dt><dd>{INCL_LABEL[inc]}{r.decision ? ` (your decision: ${r.decision.kind === 'duplicate' ? `duplicate of ${r.decision.of}` : r.decision.kind})` : ' (as delivered)'}</dd>
        <dt>Time</dt><dd>{when(e.time)}</dd>
        {e.quantity != null && <><dt>Quantity</dt><dd>{qty(e.quantity)}{r.correction?.quantity != null && <small className="t3"> · originally {qty(r.quantity!)}</small>}</dd></>}
        {e.price != null && <><dt>Price</dt><dd>{e.price.toFixed(3)}{r.correction?.price != null && <small className="t3"> · originally {r.price?.toFixed(3)}</small>}</dd></>}
        {e.amount != null && <><dt>Amount</dt><dd>{fmt(e.amount, 2)}</dd></>}
        <dt>Fee</dt><dd>{e.fee == null ? 'Not reported (unknown, not $0)' : fmt(e.fee, 2)}{r.correction?.fee !== undefined && <small className="t3"> · originally {r.fee == null ? 'not reported' : fmt(r.fee, 2)}</small>}</dd>
        <dt>Cash effect</dt><dd>{R.cashEffect(e) == null ? 'Unknown' : sfmt(R.cashEffect(e)!, 2)}{e.type === 'settlement' ? ' (creates an entitlement; cash arrives with the redemption)' : ''}</dd>
      </dl>
      {dups.length > 0 && !r.decision && <Callout tone="warn">Same account, type and terms as {dups.join(', ')}. Possibly the same transaction recorded twice, or two real identical trades.
        <span className="row" style={{ marginTop: 'var(--space-2)', flexWrap: 'wrap' }}><Button size="sm" onClick={() => onChange(`Marked ${r.key} as duplicate of ${dups[0]}`, R.markDuplicate(ws.records, r.key, dups[0]))}>Duplicate of {dups[0]}: exclude this one</Button><Button size="sm" onClick={() => onChange(`Kept ${r.key} as distinct`, R.apply(ws.records, [r.key], 'distinct'))}>Distinct trades: keep both</Button></span></Callout>}
      <div className="drawer-actions" style={{ justifyContent: 'flex-start' }}>
        {inc !== 'excluded' && <Button size="sm" onClick={() => onChange(`Excluded ${r.key}`, R.apply(ws.records, [r.key], 'exclude'))}>Exclude</Button>}
        {inc !== 'included' && <Button size="sm" onClick={() => onChange(`Included ${r.key}`, R.apply(ws.records, [r.key], 'include'))}>Include</Button>}
        {r.decision && <Button size="sm" variant="ghost" icon="reset" onClick={() => onChange(`Restored ${r.key}`, R.apply(ws.records, [r.key], 'restore'))}>Restore as delivered</Button>}
        {editable && !edit && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ quantity: e.quantity == null ? '' : String(e.quantity), price: e.price == null ? '' : String(e.price), fee: e.fee == null ? '' : String(e.fee) })}>Correct values…</Button>}
        {r.correction && <Button size="sm" variant="ghost" onClick={() => onChange(`Removed correction on ${r.key}`, R.clearCorrection(ws.records, r.key))}>Remove correction</Button>}
      </div>
      {!editable && <small className="t3">Provider records can’t be edited; exclude them or add a manual record instead. A changed provider record would appear for review.</small>}
      {edit && parsed && (
        <fieldset className="setup-f drawer-sec"><legend className="l">Correct this record <span className="t3">(original values are kept)</span></legend>
          {e.quantity != null && <label className="add-field"><span className="l">Quantity</span><input className="num-input" inputMode="decimal" value={edit.quantity} aria-invalid={parsed.q.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, quantity: ev.target.value })} /></label>}
          {e.price != null && <label className="add-field"><span className="l">Price</span><input className="num-input" inputMode="decimal" value={edit.price} aria-invalid={parsed.p.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, price: ev.target.value })} /></label>}
          <label className="add-field"><span className="l">Fee (empty = not reported)</span><input className="num-input" inputMode="decimal" value={edit.fee} aria-invalid={parsed.f.state === 'invalid'} onChange={(ev) => setEdit({ ...edit, fee: ev.target.value })} /></label>
          <div className="row"><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!okEdit} onClick={() => {
              const v = (x: ReturnType<typeof parseShares>) => (x.state === 'ok' ? x.value : null)
              onChange(`Corrected ${r.key}`, R.correct(ws.records, r.key, { ...(e.quantity != null ? { quantity: v(parsed.q) } : {}), ...(e.price != null ? { price: v(parsed.p) } : {}), fee: v(parsed.f) })); setEdit(null)
            }}>Save correction</Button></div>
        </fieldset>
      )}
    </Drawer>
  )
}

const STEPS = ['File', 'Account', 'Preview', 'Confirm', 'Result'] as const
function ImportFlow({ ws, onClose, onDone }: { ws: Workspace; onClose: () => void; onDone: (label: string, ws: Workspace) => void }) {
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(SAMPLE_FILES[0].name)
  const [target, setTarget] = useState<string>('acc-pm-a')
  const [newLabel, setNewLabel] = useState('Wallet C')
  const [mode, setMode] = useState<R.ImportMode>('supplement')
  const [accept, setAccept] = useState(true)
  const [result, setResult] = useState<Workspace | null>(null)
  const sf = SAMPLE_FILES.find((x) => x.name === file)!
  const isNew = target === 'new'
  const accountId = isNew ? `acc-new-${newLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'imported'}` : target
  const effMode: R.ImportMode = isNew ? 'independent' : mode
  const rows = useMemo(() => R.previewImport(sf, accountId, effMode, ws.records), [sf, accountId, effMode, ws.records])
  const overlaps = rows.filter((r) => r.match).length, unmatched = rows.length - overlaps, feeUnknown = rows.filter((r) => r.warnings.some((w) => w.startsWith('Fee'))).length
  const finish = () => {
    const accounts = isNew ? [...ws.accounts, { id: accountId, venue: 'pm' as const, label: newLabel.trim() || 'Imported account', kind: 'imported' as const, sources: ['csv' as const], openingDeclared: false }]
      : ws.accounts.map((a) => (a.id === accountId && !a.sources.includes('csv') ? { ...a, sources: [...a.sources, 'csv' as const] } : a))
    setResult({ accounts, records: R.confirmImport(ws.records, rows, effMode, accept) }); setStep(4)
  }
  const added = result ? result.records.filter((r) => r.batch === sf.name) : []
  return (
    <Modal title="Import a CSV file" sub="Sample files only in this build: nothing is read from your computer or uploaded" onClose={onClose} width={680}
      footer={<>{step > 0 && step < 4 && <Button variant="ghost" onClick={() => setStep(step - 1)}>Back</Button>}<span className="spacer" />
        {step < 3 && <Button variant="primary" disabled={isNew && !newLabel.trim()} onClick={() => setStep(step + 1)}>Continue</Button>}
        {step === 3 && <Button variant="primary" onClick={finish}>Import {rows.length} rows</Button>}
        {step === 4 && <Button variant="primary" onClick={() => onDone(`Imported ${sf.name}`, result!)}>Done</Button>}</>}>
      <ol className="steps" aria-label="Import steps">{STEPS.map((s, i) => <li key={s} className={cx(i === step && 'on', i < step && 'done')} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>
      {step === 0 && <fieldset className="add-list"><legend className="l">Choose a file</legend>
        {SAMPLE_FILES.map((x) => <label key={x.name} className={cx('choice', file === x.name && 'on')}><input type="radio" name="file" checked={file === x.name} onChange={() => { setFile(x.name); setTarget(x.name.startsWith('wallet-a') ? 'acc-pm-a' : 'new'); setMode(x.name.startsWith('wallet-a') ? 'supplement' : 'independent') }} /><span>{x.name} <Chip tone="warn">Sample</Chip><small>{x.about} · {x.rows.length} rows</small></span></label>)}
        <small className="t3">Importing your own files needs the Scevia backend, which isn’t connected in this build.</small></fieldset>}
      {step === 1 && <>
        <label className="add-field"><span className="l">Account these records belong to</span>
          <select className="select" style={{ maxWidth: 'none' }} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Account for import">
            {ws.accounts.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label} ({KIND_LABEL[a.kind].toLowerCase()})</option>)}
            <option value="new">New imported Polymarket account…</option></select></label>
        {isNew ? <label className="add-field"><span className="l">New account name</span><input className="text-input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} aria-label="New account name" /></label> : (
          <fieldset className="setup-f"><legend className="l">How does this file relate to the account?</legend>
            <Seg label="Import relationship" options={['Supplements its history', 'Independent records'] as const} value={mode === 'supplement' ? 'Supplements its history' : 'Independent records'} onChange={(v) => setMode(v === 'Independent records' ? 'independent' : 'supplement')} />
            <small className="t3">{mode === 'supplement' ? 'Rows that exactly match records the account already has are flagged as overlaps for you to review; nothing is merged automatically.' : 'Every row is added as its own record in this account, without overlap checks.'}</small></fieldset>
        )}
        {isNew && <small className="t3">A new imported account is independent: its records aren’t matched against other accounts, even on the same venue.</small>}
      </>}
      {step === 2 && <>
        <div className="effect"><div>Rows<b>{rows.length}</b></div><div>Overlap with existing<b>{overlaps}</b></div><div>Fees not reported<b>{feeUnknown}</b></div></div>
        <div className="dt-wrap"><table className="dt"><thead><tr><th scope="col">#</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Market</th><th scope="col" className="r">Qty</th><th scope="col" className="r">Price / amount</th><th scope="col">Notes</th></tr></thead>
          <tbody>{rows.map((x) => <tr key={x.n}><td>{x.n}</td><td className="tnum">{when(x.rec.time)}</td><td>{R.TYPE_LABEL[x.rec.type]}</td><td>{x.rec.instrument ?? '—'}</td><td className="r">{x.rec.quantity == null ? '—' : qty(x.rec.quantity)}</td><td className="r">{x.rec.price != null ? x.rec.price.toFixed(2) : x.rec.amount != null ? fmt(x.rec.amount, 2) : '—'}</td><td>{x.warnings.length ? <span className="stale">{x.warnings.join(' · ')}</span> : <span className="t3">—</span>}</td></tr>)}</tbody></table></div>
      </>}
      {step === 3 && <>
        <p className="t2">{effMode === 'independent' ? `All ${rows.length} rows will be added to ${isNew ? newLabel : ws.accounts.find((a) => a.id === target)?.label} as its own records.` : `${overlaps} overlapping row${overlaps === 1 ? '' : 's'} will wait for your review (duplicate or distinct). ${unmatched} row${unmatched === 1 ? ' has' : 's have'} no match.`}</p>
        {effMode === 'supplement' && <label className="choice"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /><span>Include the {unmatched} rows without a match<small>Otherwise they also wait for review. You can change any row later.</small></span></label>}
        <small className="t3">Nothing is merged automatically, and you can exclude or restore any imported row afterwards.</small>
      </>}
      {step === 4 && result && <>
        <div className="effect"><div>Imported<b>{added.length}</b></div><div>Included<b>{added.filter((r) => R.inclusionOf(r) === 'included').length}</b></div><div>Waiting for review<b>{added.filter((r) => R.inclusionOf(r) === 'review').length}</b></div></div>
        <small className="t3">Find them under Records (filter by batch name). Review overlaps from the “need review” button.</small>
      </>}
    </Modal>
  )
}

function ManualRecord({ ws, onClose, onAdd }: { ws: Workspace; onClose: () => void; onAdd: (ws: Workspace, label: string) => void }) {
  const owned = ws.accounts.filter((a) => a.kind !== 'connected')
  const [acct, setAcct] = useState(owned[0]?.id ?? 'new-manual')
  const [type, setType] = useState<RecordType>('buy')
  const [date, setDate] = useState('2026-11-20')
  const [market, setMarket] = useState('')
  const [q, setQ] = useState(''), [p, setP] = useState(''), [amt, setAmt] = useState(''), [fee, setFee] = useState('0')
  const trade = type === 'buy' || type === 'sell'
  const pq = parseShares(q), pp = parsePrice(p), pa = parseMoney(amt), pf = parseMoney(fee)
  const ok = !!date && (trade ? market.trim() && pq.state === 'ok' && pp.state === 'ok' : pa.state === 'ok') && pf.state !== 'invalid' && pf.state !== 'partial'
  const add = () => {
    const accounts = acct === 'new-manual' ? [...ws.accounts, { id: 'acc-manual', venue: 'pm' as const, label: 'Manual records', kind: 'manual' as const, sources: ['manual' as const], openingDeclared: false }] : ws.accounts
    const accountId = acct === 'new-manual' ? 'acc-manual' : acct
    const rec: FinRecord = { key: `m-${Date.now().toString(36)}`, accountId, source: 'manual', batch: null, time: `${date}T12:00:00Z`, type, instrument: trade ? market.trim() : null, side: trade ? 'YES' : null,
      quantity: trade && pq.state === 'ok' ? pq.value : null, price: trade && pp.state === 'ok' ? pp.value : null, amount: !trade && pa.state === 'ok' ? pa.value : null, fee: pf.state === 'ok' ? pf.value : null }
    onAdd({ accounts, records: [...ws.records, { ...rec, initial: 'included', decision: null, correction: null }] }, `Added a manual ${R.TYPE_LABEL[type].toLowerCase()}`)
  }
  return (
    <Modal title="Add a manual record" sub="For an imported or manual account. Connected accounts get their records from the provider." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} onClick={add}>Add record</Button></>}>
      <label className="add-field"><span className="l">Account</span><select className="select" style={{ maxWidth: 'none' }} value={acct} onChange={(e) => setAcct(e.target.value)} aria-label="Manual record account">{owned.map((a) => <option key={a.id} value={a.id}>{PLATFORM_NAME[a.venue]} · {a.label}</option>)}<option value="new-manual">New manual account</option></select></label>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="add-field"><span className="l">Type</span><select className="select" value={type} onChange={(e) => setType(e.target.value as RecordType)} aria-label="Record type">{(['buy', 'sell', 'deposit', 'withdrawal', 'fee'] as RecordType[]).map((t) => <option key={t} value={t}>{R.TYPE_LABEL[t]}</option>)}</select></label>
        <label className="add-field"><span className="l">Date</span><input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Record date" /></label>
      </div>
      {trade ? <>
        <label className="add-field"><span className="l">Market (YES side)</span><input className="text-input" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market" placeholder="e.g. Bitcoin above $150k on Dec 31" /></label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="add-field"><span className="l">Quantity</span><input className="num-input" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quantity" aria-invalid={pq.state === 'invalid'} /></label>
          <label className="add-field"><span className="l">Price</span><input className="num-input" inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} aria-label="Price" aria-invalid={pp.state === 'invalid'} /></label>
        </div>
      </> : <label className="add-field"><span className="l">Amount</span><input className="num-input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" aria-invalid={pa.state === 'invalid'} /></label>}
      <label className="add-field"><span className="l">Fee (leave empty if unknown)</span><input className="num-input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} aria-label="Fee" aria-invalid={pf.state === 'invalid'} /></label>
    </Modal>
  )
}
