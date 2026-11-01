/**
 * dsh-mail browser half: the Mail tab. A pane stack (list, thread, folders,
 * queue, settings) sized for a narrow sidebar, with an account switcher, a
 * compose sheet and the review queue. The host is the authority for
 * everything; the tab only renders and asks.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, apiGet, apiPost } from './api.js'
import { loadSel, saveSel, relTime, fullTime, initials } from './util.js'
import { ThreadList } from './list.jsx'
import { ThreadView } from './thread.jsx'
import { AccountsEditor } from './accounts.jsx'
import { I } from './icons.jsx'

const POLL_MS = 60000
const ROLE_LABEL = { inbox: 'Inbox', flagged: 'Starred', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', all: 'All mail', junk: 'Spam', trash: 'Trash' }

export const shared = { badge: 0, listeners: new Set() }
function setBadge(n) { shared.badge = n; for (const f of shared.listeners) { try { f(n) } catch {} } }

function useStateRoute(visible) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { const r = await apiGet('/state'); setState(r); setError(''); setBadge(r.accounts.reduce((n, a) => n + (a.unread || 0), 0)) }
    catch (e) { setError(e.message) }
  }, [])
  useEffect(() => {
    if (visible === false) return undefined
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [visible, load])
  return { state, error, load }
}

/** Minimal rich editor: contentEditable with a small toolbar (bold, italic, link, list, quote). */
function RichEditor({ html, onChange }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html || '' }, [])
  const cmd = (c, v) => { try { document.execCommand(c, false, v) } catch {} ; if (ref.current) onChange(ref.current.innerHTML) }
  const link = () => { const u = window.prompt('Link address (https://...)'); if (u && /^(https?:|mailto:)/i.test(u)) cmd('createLink', u) }
  return (
    <div>
      <div className="mlx-flex" role="toolbar" aria-label="Formatting" style={{ marginBottom: 4 }}>
        <button type="button" className="mlx-btn" aria-label="Bold" onMouseDown={e => { e.preventDefault(); cmd('bold') }}><b>B</b></button>
        <button type="button" className="mlx-btn" aria-label="Italic" onMouseDown={e => { e.preventDefault(); cmd('italic') }}><i>I</i></button>
        <button type="button" className="mlx-btn" aria-label="Link" onMouseDown={e => { e.preventDefault(); link() }}>Link</button>
        <button type="button" className="mlx-btn" aria-label="Bulleted list" onMouseDown={e => { e.preventDefault(); cmd('insertUnorderedList') }}>List</button>
        <button type="button" className="mlx-btn" aria-label="Quote" onMouseDown={e => { e.preventDefault(); cmd('formatBlock', 'blockquote') }}>Quote</button>
      </div>
      <div ref={ref} className="mlx-in mlx-rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message"
        style={{ minHeight: 200, overflowWrap: 'anywhere' }} onInput={e => onChange(e.currentTarget.innerHTML)} />
    </div>
  )
}

function Composer({ state, init, onClose, onSent, toast }) {
  const senders = (state.accounts || []).filter(a => a.enabled && a.capabilities.includes('send'))
  const defSender = senders.find(a => a.id === init.account) || senders.find(a => a.id === state.defaultAccount) || senders[0]
  const [f, setF] = useState({ account: defSender ? defSender.id : '', to: init.to || '', cc: init.cc || '', bcc: '', subject: init.subject || '', text: init.text || '', html: '', format: 'plain', inReplyTo: init.inReplyTo || '', references: init.references || '', threadId: init.threadId || '' })
  const [showCc, setShowCc] = useState(!!init.cc)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState({ id: '', savedAt: 0 })
  const lastSaved = useRef('')
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  // Autosave every 5 s while something changed (IMAP accounts also keep the draft in Drafts).
  useEffect(() => {
    const t = setInterval(async () => {
      const snap = JSON.stringify(f)
      if (snap === lastSaved.current || !(f.text || f.html || f.subject || f.to) || !f.account) return
      lastSaved.current = snap
      try { const r = await apiPost('/drafts/save', { draft: { id: draft.id || undefined, account: f.account, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, text: f.format === 'rich' ? '' : f.text, html: f.format === 'rich' ? f.html : '', format: f.format, inReplyTo: f.inReplyTo, references: f.references } }); setDraft({ id: r.id, savedAt: r.savedAt }) } catch {}
    }, 5000)
    return () => clearInterval(t)
  }, [f, draft.id])
  async function send() {
    setBusy(true); setErr('')
    try {
      const r = await apiPost('/send', { ...f, undo: true, draftId: draft.id || undefined })
      onSent(r.held ? { held: true, id: r.outboxId, sendAt: r.sendAt } : 'Sent.')
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const dirty = f.text || f.html || f.subject || f.to
  return (
    <div className="mlx-compose" role="dialog" aria-label="Compose">
      <div className="mlx-handle" />
      <div className="mlx-hd" style={{ borderBottom: '1px solid var(--line1)' }}>
        <button type="button" className="mlx-btn" onClick={() => { if (!dirty || window.confirm(draft.id ? 'Close? The draft is saved.' : 'Discard this message?')) onClose() }}>Cancel</button>
        <span className="t" style={{ textAlign: 'center' }}>{init.title || 'New message'}</span>
        <button type="button" className="mlx-btn p" disabled={busy || !f.account || (!f.to && !f.threadId)} onClick={() => void send()}>{busy ? 'Sending...' : 'Send'}</button>
      </div>
      <div className="mlx-body mlx-pad">
        {err ? <div className="mlx-note bad" style={{ margin: '0 0 8px' }}>{err}</div> : null}
        {!senders.length ? <div className="mlx-note warn" style={{ margin: '0 0 8px' }}>No account can send. Add one with the gear button.</div> : null}
        <label className="mlx-field"><span>From</span>
          <select className="mlx-in" value={f.account} onChange={e => set('account', e.target.value)}>
            {senders.map(a => <option key={a.id} value={a.id}>{a.label}{a.address ? ' <' + a.address + '>' : ''}</option>)}
          </select>
        </label>
        <label className="mlx-field"><span>To</span><input className="mlx-in" value={f.to} onChange={e => set('to', e.target.value)} placeholder="name@example.com, ..." /></label>
        {showCc ? <div className="mlx-grid">
          <label className="mlx-field"><span>Cc</span><input className="mlx-in" value={f.cc} onChange={e => set('cc', e.target.value)} /></label>
          <label className="mlx-field"><span>Bcc</span><input className="mlx-in" value={f.bcc} onChange={e => set('bcc', e.target.value)} /></label>
        </div> : <button type="button" className="mlx-btn" style={{ marginBottom: 8 }} onClick={() => setShowCc(true)}>Cc / Bcc</button>}
        <label className="mlx-field"><span>Subject</span><input className="mlx-in" value={f.subject} onChange={e => set('subject', e.target.value)} /></label>
        <div className="mlx-chips" style={{ padding: '0 0 6px' }} role="radiogroup" aria-label="Format">
          {[['plain', 'Plain'], ['markdown', 'Markdown'], ['rich', 'Rich text']].map(([k, l]) => <button key={k} type="button" className="mlx-fchip" aria-pressed={f.format === k} onClick={() => set('format', k)}>{l}</button>)}
        </div>
        {f.format === 'rich' ? <RichEditor html={f.html || (f.text ? f.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') : '')} onChange={v => set('html', v)} />
          : <textarea className="mlx-in" rows={12} value={f.text} onChange={e => set('text', e.target.value)} aria-label="Message" autoFocus placeholder={f.format === 'markdown' ? '**bold**, _italic_, [link](https://...), - lists, > quotes' : ''} />}
        <div className="mlx-s" style={{ marginTop: 6 }}>{draft.savedAt ? 'Draft saved ' + new Date(draft.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. ' : ''}The account signature is added when sending.</div>
      </div>
    </div>
  )
}

function AuditList() {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (open) apiGet('/audit', { limit: 40 }).then(r => setRows(r.entries.reverse())).catch(() => setRows([])) }, [open])
  return (
    <details style={{ margin: '4px 10px' }} onToggle={e => setOpen(e.target.open)}>
      <summary className="mlx-s" style={{ cursor: 'pointer' }}>Recent activity (audit log)</summary>
      {(rows || []).map((r, i) => (
        <div key={i} className="mlx-s mlx-mono" style={{ padding: '2px 0' }}>{r.ts.slice(5, 16).replace('T', ' ')} {r.actor} {r.action}{r.account ? ' ' + r.account : ''}{r.recipients != null ? ' to ' + r.recipients : ''}{r.ok === false ? ' FAILED' : ''}{r.note ? ' (' + r.note + ')' : ''}</div>
      ))}
      {rows && !rows.length ? <div className="mlx-s">Nothing yet.</div> : null}
    </details>
  )
}

function SuppressionPane({ toast }) {
  const [data, setData] = useState(null)
  const [camps, setCamps] = useState([])
  const [q, setQ] = useState('')
  const [add, setAdd] = useState('')
  const [err, setErr] = useState('')
  const load = () => { apiGet('/suppress').then(setData).catch(e => setErr(e.message)); apiGet('/campaigns').then(r => setCamps(r.campaigns)).catch(() => {}) }
  useEffect(() => { load() }, [])
  const post = async (body, msg) => { setErr(''); try { await apiPost('/suppress', body); toast(msg); load() } catch (e) { setErr(e.message) } }
  const rows = data ? [...data.global.map(e => ({ address: e.address, scope: '', reason: e.reason })), ...Object.entries(data.lists).flatMap(([l, m]) => Object.entries(m).map(([a, v]) => ({ address: a, scope: l, reason: v.reason })))] : []
  const shown = rows.filter(r => !q || r.address.includes(q.toLowerCase()) || r.scope.includes(q.toLowerCase()))
  return (
    <div className="mlx-body">
      <div className="mlx-ftitle"><h2>Unsubscribes</h2><span className="mlx-pill">{rows.length}</span><a className="mlx-btn" href={API + '/suppress?format=csv'} download="dsh-mail-suppression.csv">Export CSV</a></div>
      <div className="mlx-s" style={{ padding: '0 12px 6px' }}>Mass sends skip these addresses. "All mail" blocks every mass send; a list entry blocks only that list. Unsubscribe links, one-click unsubscribes, unsubscribe replies and hard bounces land here.</div>
      <div className="mlx-search"><input type="search" className="mlx-in" placeholder="Search address or list" value={q} onChange={e => setQ(e.target.value)} aria-label="Search unsubscribes" /></div>
      <div className="mlx-search"><input className="mlx-in" placeholder="Add name@example.com or @example.com" value={add} onChange={e => setAdd(e.target.value)} aria-label="Address to block" /><button type="button" className="mlx-btn" disabled={!add} onClick={() => { void post({ add }, 'Added.'); setAdd('') }}>Block</button></div>
      {err ? <div className="mlx-note bad">{err}</div> : null}
      {!data ? <div className="mlx-skel" /> : !shown.length ? <div className="mlx-empty">{q ? 'No match.' : 'Nobody has unsubscribed yet.'}</div> : (
        <ul className="mlx-list" role="list">
          {shown.slice(0, 500).map(r => (
            <li key={r.scope + r.address} className="mlx-li" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px' }}>
              <span style={{ flex: 1, minWidth: 0 }}><span className="mlx-mono" style={{ overflowWrap: 'anywhere' }}>{r.address}</span><div className="mlx-s">{r.scope ? 'list ' + r.scope : 'all mail'}{r.reason ? ' · ' + r.reason : ''}</div></span>
              <button type="button" className="mlx-btn d" aria-label={'Remove ' + r.address} onClick={() => { if (window.confirm('Remove ' + r.address + ' from ' + (r.scope ? 'the list ' + r.scope : 'the global list') + '? Mass sends will reach this address again.')) void post({ remove: r.address, list: r.scope || undefined }, 'Removed.') }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {camps.length ? <>
        <div className="mlx-h">Campaigns</div>
        {camps.slice(0, 30).map(c => <div key={c.id} className="mlx-qrow"><div className="mlx-flex"><b style={{ flex: 1 }}>{c.list}</b><span className="mlx-s">{fullTime(c.createdAt)}</span></div><div className="mlx-s">{c.account} · {c.sent} sent · {c.unsubscribed} unsubscribed · <span className="mlx-mono">{c.id}</span></div></div>)}
      </> : null}
    </div>
  )
}

function QueuePane({ state, reload, toast }) {
  const [busy, setBusy] = useState('')
  const act = async (path, body, okMsg) => {
    setBusy(path + body.id)
    try { await apiPost(path, body); toast(okMsg) } catch (e) { toast('Failed: ' + e.message) } finally { setBusy(''); await reload() }
  }
  const drafts = state.drafts || []
  const queue = state.queue || []
  return (
    <div className="mlx-body">
      <div className="mlx-h">Agent drafts awaiting you</div>
      {drafts.length === 0 ? <div className="mlx-empty" style={{ padding: '6px 12px' }}>No drafts. With "draft first", agent sends wait here.</div> : drafts.map(d => (
        <div key={d.id} className="mlx-qrow">
          <div className="mlx-flex"><span className="mlx-pill">{d.by}</span><b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.subject || '(no subject)'}</b><span className="mlx-s">{relTime(d.updatedAt)}</span></div>
          <div className="mlx-s">via <b>{d.account}</b> to {d.to}{d.cc ? ', cc ' + d.cc : ''}{d.attachments && d.attachments.length ? ' · ' + d.attachments.length + ' attachment(s)' : ''}</div>
          <div className="mlx-s" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', marginTop: 4 }}>{d.text}</div>
          <div className="mlx-flex" style={{ marginTop: 6 }}>
            <button type="button" className="mlx-btn p" disabled={!!busy} onClick={() => void act('/drafts/send', { id: d.id }, 'Sent.')}>Send</button>
            <button type="button" className="mlx-btn d" disabled={!!busy} onClick={() => void act('/drafts/delete', { id: d.id }, 'Draft deleted.')}>Discard</button>
          </div>
        </div>
      ))}
      <AuditList />
      <div className="mlx-h">Queue</div>
      {queue.length === 0 ? <div className="mlx-empty" style={{ padding: '6px 12px' }}>Scheduled and mass sends appear here for review.</div> : queue.map(q => {
        const tone = q.status === 'sent' ? 'var(--ok)' : q.status === 'failed' ? 'var(--bad)' : q.status === 'cancelled' ? 'var(--ink3)' : 'var(--warn)'
        const pending = q.status === 'queued' || q.status === 'scheduled' || q.status === 'failed'
        return (
          <div key={q.id} className="mlx-qrow">
            <div className="mlx-flex"><span className="mlx-pill" style={{ color: tone }}>{q.status}</span><b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.msg.subject || q.name}</b></div>
            <div className="mlx-s">via <b>{q.provider}</b> · {q.msg.to || (q.csvData ? q.csvData.rows.length + ' recipients' : '')} · {fullTime(q.created_at * 1000)}</div>
            {q.sendAt ? <div className="mlx-s">Scheduled for {fullTime(q.sendAt * 1000)}</div> : null}
            {q.requestedSendAt && q.status === 'queued' ? <div className="mlx-s">Agent asked for {fullTime(q.requestedSendAt * 1000)}</div> : null}
            {q.lastError ? <div className="mlx-s" style={{ color: 'var(--bad)' }}>{q.lastError}</div> : null}
            {q.status === 'sent' && q.sentCount != null ? <div className="mlx-s">{q.sentCount} sent, {q.failedCount || 0} failed</div> : null}
            {pending ? <div className="mlx-flex" style={{ marginTop: 6 }}>
              {q.status === 'queued' && q.requestedSendAt ? <button type="button" className="mlx-btn p" disabled={!!busy} onClick={() => void act('/queue/approve', { id: q.id }, 'Approved.')}>Approve</button> : null}
              <button type="button" className={'mlx-btn' + (q.requestedSendAt ? '' : ' p')} disabled={!!busy} onClick={() => void act('/queue/send', { id: q.id }, 'Sent.')}>Send now</button>
              <button type="button" className="mlx-btn d" disabled={!!busy} onClick={() => void act('/queue/cancel', { id: q.id }, 'Cancelled.')}>Cancel</button>
            </div> : null}
          </div>
        )
      })}
    </div>
  )
}

function FoldersPane({ state, sel, choose }) {
  const readers = (state.accounts || []).filter(a => a.enabled && a.receive !== 'none')
  const [folders, setFolders] = useState({})
  const [more, setMore] = useState({})
  const reloadFolders = id => apiGet('/folders', { account: id }).then(r => setFolders(f => ({ ...f, [id]: r.folders }))).catch(e => setFolders(f => ({ ...f, [id]: { error: e.message } })))
  useEffect(() => {
    for (const a of readers) void reloadFolders(a.id)
  }, [readers.map(a => a.id).join(',')])
  const totalUnread = readers.reduce((n, a) => n + (a.unread || 0), 0)
  return (
    <div className="mlx-body">
      <button type="button" className="mlx-fold" aria-current={sel.account === 'all'} onClick={() => choose({ account: 'all', folder: '' })}>
        {I.mail(15)}<span className="nm"><b>All inboxes</b></span>{totalUnread ? <span className="mlx-pill b">{totalUnread}</span> : null}
      </button>
      {readers.map(a => {
        const fl = folders[a.id]
        const list = Array.isArray(fl) ? fl : []
        const main = list.filter(x => x.role && ROLE_LABEL[x.role])
        const custom = list.filter(x => !x.role || !ROLE_LABEL[x.role])
        return (
          <div key={a.id}>
            <div className="mlx-h" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="mlx-dot" style={{ background: a.color }} />{a.label}</div>
            {fl && fl.error ? <div className="mlx-s" style={{ padding: '0 14px', color: 'var(--bad)' }}>{fl.error}</div> : null}
            {!fl ? <div className="mlx-s" style={{ padding: '0 14px' }}>Loading...</div> : null}
            {main.map(x => (
              <button key={x.path} type="button" className="mlx-fold" aria-current={sel.account === a.id && (sel.folder || 'INBOX') === x.path} onClick={() => choose({ account: a.id, folder: x.path, title: ROLE_LABEL[x.role] })}>
                {x.role === 'inbox' ? I.mail(15) : x.role === 'trash' ? I.trash(15) : x.role === 'archive' || x.role === 'all' ? I.archive(15) : x.role === 'flagged' ? I.flag(15) : I.folder(15)}
                <span className="nm">{ROLE_LABEL[x.role]}</span>{x.unseen ? <span className="mlx-pill">{x.unseen}</span> : null}
              </button>
            ))}
            {a.receive === 'imap' ? <div className="mlx-flex" style={{ padding: '2px 14px' }}>
              <button type="button" className="mlx-btn" onClick={async () => { const n = window.prompt('New folder name'); if (!n) return; try { await apiPost('/folders/create', { account: a.id, name: n }); reloadFolders(a.id) } catch (e) { window.alert(e.message) } }}>New folder</button>
            </div> : null}
            {custom.length ? <>
              <button type="button" className="mlx-fold" onClick={() => setMore({ ...more, [a.id]: !more[a.id] })} aria-expanded={!!more[a.id]}>{I.folder(15)}<span className="nm">More</span><span className="mlx-s">{custom.length}</span></button>
              {more[a.id] ? custom.map(x => (
                <div key={x.path} className="mlx-flex" style={{ gap: 0 }}>
                  <button type="button" className="mlx-fold" style={{ paddingLeft: 30, flex: 1, minWidth: 0 }} aria-current={sel.account === a.id && sel.folder === x.path} onClick={() => choose({ account: a.id, folder: x.path, title: x.name })}>
                    <span className="nm">{x.path}</span>{x.unseen ? <span className="mlx-pill">{x.unseen}</span> : null}
                  </button>
                  {a.receive === 'imap' ? <button type="button" className="mlx-ib" aria-label={'Rename ' + x.path} onClick={async () => { const n = window.prompt('Rename folder', x.path); if (!n || n === x.path) return; try { await apiPost('/folders/rename', { account: a.id, from: x.path, to: n }); reloadFolders(a.id) } catch (er) { window.alert(er.message) } }}>{I.pen(13)}</button> : null}
                </div>
              )) : null}
            </> : null}
          </div>
        )
      })}
      {!readers.length ? <div className="mlx-empty">No account can read mail yet. Add one with the gear button.</div> : null}
    </div>
  )
}

export function MailView({ visible }) {
  const { state, error, load } = useStateRoute(visible)
  const [sel, setSel] = useState(loadSel)
  const [pane, setPane] = useState('list')
  const [switcher, setSwitcher] = useState(false)
  const [rows, setRows] = useState([])
  const [listErr, setListErr] = useState([])
  const [loading, setLoading] = useState(false)
  const [updated, setUpdated] = useState(0)
  const [q, setQ] = useState('')
  const [scope, setScope] = useState('folder')
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(null)
  const [cursor, setCursor] = useState(-1)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [compose, setCompose] = useState(null)
  const [toastMsg, setToastMsg] = useState('')
  const [undo, setUndo] = useState(null)
  const rootRef = useRef(null)
  const toast = m => { setToastMsg(m); setTimeout(() => setToastMsg(''), 4000) }

  const accounts = (state && state.accounts) || []
  const selAcc = accounts.find(a => a.id === sel.account)
  const unified = !selAcc

  const fetchList = useCallback(async (opts = {}) => {
    setLoading(true)
    try {
      const params = { account: unified ? 'all' : sel.account, folder: unified ? '' : sel.folder, q: q.trim(), filter, limit: 100 }
      if (q.trim() && scope === 'all') { params.account = unified ? 'all' : sel.account; params.folder = '' }
      if (opts.nosync) params.sync = '0'
      const r = await apiGet('/messages', params)
      setRows(r.rows); setListErr(r.errors || []); setUpdated(r.updatedAt)
    } catch (e) { setListErr([{ account: '', error: e.message }]) }
    finally { setLoading(false) }
  }, [sel.account, sel.folder, q, scope, filter, unified])

  useEffect(() => { if (visible !== false && state) void fetchList() }, [visible, sel.account, sel.folder, filter, !!state])
  useEffect(() => {
    if (visible === false || typeof EventSource === 'undefined') return undefined
    let es
    try { es = new EventSource(API + '/events'); es.addEventListener('sync', () => { void fetchList({ nosync: true }); void load() }) } catch {}
    return () => { try { es && es.close() } catch {} }
  }, [visible, fetchList])
  useEffect(() => { const t = setTimeout(() => { if (state) void fetchList() }, 350); return () => clearTimeout(t) }, [q, scope])
  useEffect(() => {
    const on = ev => { if (ev && ev.data && ev.data.type === 'dsh-mail-oauth') { void load(); void fetchList() } }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [load, fetchList])

  const choose = v => { const next = { account: v.account, folder: v.folder || '', title: v.title || '' }; setSel(next); saveSel(next); setPane('list'); setSwitcher(false); setOpen(null); setSelected(new Set()); setSelecting(false) }

  /** Apply an action to thread rows: archive | trash | read | unread | flag | unflag. */
  const act = async (threads, action) => {
    try {
      const ids = []
      for (const t of threads) {
        const a = accounts.find(x => x.id === t.account)
        if (a && a.receive === 'tzekos') ids.push(t.id)
        else {
          const r = await apiGet('/thread', { account: t.account, thread: t.thread, folder: t.folder })
          for (const m of r.messages || []) if (action === 'archive' || action === 'trash' ? m.folder === t.folder : true) ids.push(m.id)
        }
      }
      if (!ids.length) return
      if (action === 'archive' || action === 'trash') {
        const prev = rows
        setRows(rows.filter(r => !threads.some(t => t.account === r.account && t.thread === r.thread)))
        try { await apiPost('/messages/move', { ids, to: action }); toast(action === 'archive' ? 'Archived.' : 'Moved to Trash.') }
        catch (e) { setRows(prev); throw e }
      } else {
        await apiPost('/messages/mark', { ids, op: action })
        setRows(rs => rs.map(r => threads.some(t => t.account === r.account && t.thread === r.thread)
          ? { ...r, unread: action === 'read' ? 0 : action === 'unread' ? Math.max(1, r.unread) : r.unread, flagged: action === 'flag' ? true : action === 'unflag' ? false : r.flagged } : r))
      }
      void load()
    } catch (e) { toast('Failed: ' + e.message) }
  }

  const openThread = t => {
    setOpen(t); setPane('thread')
    if (t.unread) void act([t], 'read')
  }

  const reply = (m, mode) => {
    if (!open) return
    const re = s => (/^\s*re:/i.test(s || '') ? s : 'Re: ' + (s || ''))
    const fw = s => (/^\s*fwd?:/i.test(s || '') ? s : 'Fwd: ' + (s || ''))
    const quoted = (m.text || m.snippet || '').split('\n').map(l => '> ' + l).join('\n')
    const head = 'On ' + fullTime(m.date) + ', ' + ((m.from && (m.from.name || m.from.address)) || 'someone') + ' wrote:'
    const a = accounts.find(x => x.id === open.account)
    const tz = a && a.receive === 'tzekos'
    setCompose(mode === 'forward'
      ? { title: 'Forward', account: open.account, subject: fw(m.subject || open.subject), text: '\n\n---------- Forwarded message ----------\nFrom: ' + ((m.from && m.from.address) || '') + '\nDate: ' + fullTime(m.date) + '\nSubject: ' + (m.subject || '') + '\n\n' + (m.text || m.snippet || '') }
      : { title: 'Reply', account: open.account, to: tz ? '' : ((m.from && m.from.address) || ''), subject: re(m.subject || open.subject), text: '\n\n' + head + '\n' + quoted, inReplyTo: m.messageId || '', references: [m.references, m.messageId].filter(Boolean).join(' '), threadId: tz ? open.thread : '' })
  }

  const onKey = e => {
    if (compose || pane === 'settings') return
    const tag = (e.target && e.target.tagName) || ''
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); const n = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === 'j' ? 1 : -1))); setCursor(n); if (pane === 'thread' && rows[n]) openThread(rows[n]) }
    else if (e.key === 'Enter' && pane === 'list' && rows[cursor]) openThread(rows[cursor])
    else if (e.key === 'e' || e.key === '#') { const t = pane === 'thread' ? open : rows[cursor]; if (t) { void act([t], e.key === 'e' ? 'archive' : 'trash'); if (pane === 'thread') setPane('list') } }
    else if (e.key === 'r' && pane === 'thread') { const b = rootRef.current && rootRef.current.querySelector('.mlx-tb ~ div button.mlx-in'); if (b) b.click() }
    else if (e.key === 'c') { e.preventDefault(); setCompose({ title: 'New message', account: unified ? '' : sel.account }) }
    else if (e.key === '/') { e.preventDefault(); const i = rootRef.current && rootRef.current.querySelector('input[type=search]'); if (i) i.focus() }
    else if (e.key === 'Escape' && pane !== 'list') setPane('list')
  }

  const title = unified ? 'All inboxes' : (sel.title || (sel.folder && sel.folder !== 'INBOX' && sel.folder !== 'inbox' ? sel.folder : 'Inbox'))
  const unreadHere = rows.reduce((n, r) => n + (r.unread ? 1 : 0), 0)
  const pendingCount = state ? state.queueCounts.pending : 0
  const reauth = accounts.filter(a => a.oauth && a.oauth.needsReauth)
  const statusIssues = accounts.filter(a => a.status && !a.status.ok && !(a.oauth && a.oauth.needsReauth))
  async function reconnect(a) {
    const w = window.open('about:blank', 'dsh-mail-oauth', 'width=520,height=700')
    try { const r = await apiPost('/oauth/start', { account: a.id }); if (w) w.location.href = r.url; else toast('Allow pop-ups for this site, then press Reconnect again.') }
    catch (e) { if (w) w.close(); toast('Reconnect failed: ' + e.message) }
  }
  const activeKey = open ? open.account + '|' + open.thread : (rows[cursor] ? rows[cursor].account + '|' + rows[cursor].thread : '')
  const selRows = rows.filter(r => selected.has(r.account + '|' + r.thread))

  return (
    <div className="mlx" ref={rootRef} tabIndex={-1} onKeyDown={onKey}>
      <div className="mlx-hd">
        {pane !== 'list' ? <button type="button" className="mlx-ib" aria-label="Back" onClick={() => { setPane('list'); setOpen(null) }}>{I.back(16)}</button>
          : <button type="button" className="mlx-ib" aria-label="Folders" onClick={() => setPane('folders')}>{I.menu(16)}</button>}
        <button type="button" className="mlx-chip" aria-label="Switch account" aria-expanded={switcher} onClick={() => setSwitcher(!switcher)}>
          <span className={selAcc ? "mlx-av" : "mlx-av b"} style={{ width: 24, height: 24, fontSize: 10, background: selAcc ? selAcc.color : 'var(--brand)' }}>{selAcc ? initials(selAcc.label, selAcc.address) : 'All'}</span>
          <span className="n">{selAcc ? selAcc.label : 'All inboxes'}</span>
        </button>
        <span className="t" />
        <button type="button" className="mlx-ib" aria-label="Refresh" title="Refresh" onClick={() => { void apiPost('/sync', unified ? {} : { account: sel.account, folder: sel.folder || undefined }).catch(() => {}).then(() => fetchList()); void load() }}>{I.refresh(15)}</button>
        <button type="button" className="mlx-ib" aria-label={'Queue, ' + pendingCount + ' pending'} aria-pressed={pane === 'queue'} title="Review queue" onClick={() => setPane(pane === 'queue' ? 'list' : 'queue')}>{I.queue(15)}{pendingCount ? <span className="mlx-badge">{pendingCount}</span> : null}</button>
        <button type="button" className="mlx-ib" aria-label="Unsubscribes" aria-pressed={pane === 'suppress'} title="Unsubscribes and suppression" onClick={() => setPane(pane === 'suppress' ? 'list' : 'suppress')}>{I.block(15)}</button>
        <button type="button" className="mlx-ib" aria-label="Settings" aria-pressed={pane === 'settings'} title="Accounts and settings" onClick={() => setPane(pane === 'settings' ? 'list' : 'settings')}>{I.gear(15)}</button>
      </div>

      {switcher && state ? <div className="mlx-sheet" role="menu">
        <button type="button" className="it" aria-current={unified} onClick={() => choose({ account: 'all' })}>
          <span className="mlx-av b" style={{ width: 28, height: 28, fontSize: 10, background: 'var(--brand)' }}>All</span>
          <span className="meta"><div><b>All inboxes</b></div></span>
        </button>
        {accounts.filter(a => a.receive !== 'none').map(a => (
          <button key={a.id} type="button" className="it" aria-current={sel.account === a.id} onClick={() => choose({ account: a.id, folder: '' })}>
            <span className="mlx-av" style={{ width: 28, height: 28, fontSize: 10, background: a.color }}>{initials(a.label, a.address)}</span>
            <span className="meta"><div><b>{a.label}</b>{(a.status && !a.status.ok) || (a.oauth && a.oauth.needsReauth) ? <span className="mlx-dot" style={{ background: 'var(--warn)', marginLeft: 6 }} title={(a.oauth && a.oauth.needsReauth) ? 'needs to reconnect' : a.status.error} /> : null}</div><div className="mlx-s">{a.address || a.type}</div></span>
            {a.unread ? <span className="mlx-pill b">{a.unread}</span> : null}
          </button>
        ))}
        <button type="button" className="it" onClick={() => { setSwitcher(false); setPane('settings') }}><span className="mlx-ib">{I.gear(15)}</span><span className="meta"><div>Add account / Manage</div></span></button>
      </div> : null}

      {error ? <div className="mlx-strip bad">Mail route unreachable: {error}</div> : null}
      {reauth.map(a => (
        <div key={a.id} className="mlx-strip warn" role="alert">
          <span style={{ flex: 1 }}>{a.label} needs to reconnect{a.oauth.reason ? ': ' + a.oauth.reason.slice(0, 140) : ''}</span>
          <button type="button" onClick={() => void reconnect(a)}>Reconnect</button>
        </div>
      ))}
      {statusIssues.length && pane === 'list' ? <div className="mlx-strip warn">{statusIssues.map(a => a.label).join(', ')}: {statusIssues[0].status.error} <button type="button" onClick={() => setPane('settings')}>Test</button></div> : null}

      {pane === 'list' ? <>
        <div className="mlx-body">
          <div className="mlx-ftitle">
            <h2>{title}</h2>
            {unreadHere ? <span className="mlx-pill b">{unreadHere}</span> : null}
            <button type="button" className="mlx-ib" aria-label="Select conversations" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected(new Set()) }}>{I.check(15)}</button>
          </div>
          <div className="mlx-search">
            <input type="search" className="mlx-in" placeholder="Search (from:, subject:, is:unread)" value={q} onChange={e => setQ(e.target.value)} aria-label="Search mail" />
          </div>
          <div className="mlx-chips">
            {q ? <>
              <button type="button" className="mlx-fchip" aria-pressed={scope === 'folder'} onClick={() => setScope('folder')}>This folder</button>
              <button type="button" className="mlx-fchip" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All mail</button>
            </> : null}
            {[['', 'All'], ['unread', 'Unread'], ['flagged', 'Flagged'], ['attachments', 'Attachments']].map(([k, l]) => (
              <button key={k} type="button" className="mlx-fchip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <div className="mlx-s" style={{ padding: '0 12px 4px' }}>{loading ? 'Updating...' : updated ? 'Updated ' + new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
          {listErr.length ? <div className="mlx-note warn">{listErr.map(e => (e.account ? e.account + ': ' : '') + e.error).join(' · ')}</div> : null}
          {state && accounts.length === 0 ? <div className="mlx-empty">Add your first account to read mail here.<div style={{ marginTop: 8 }}><button type="button" className="mlx-btn p" onClick={() => setPane('settings')}>Add account</button></div></div>
            : <ThreadList rows={rows} loading={loading || !state} unified={unified} activeKey={activeKey} selecting={selecting} selected={selected} setSelected={setSelected} onOpen={openThread} onAct={(ts, a) => void act(ts, a)}
              empty={q ? 'Nothing matches this search.' : filter ? 'Nothing here with this filter.' : 'No conversations here.'} />}
          <div style={{ height: 70 }} />
        </div>
        {selecting && selRows.length ? <div className="mlx-bulk" role="toolbar" aria-label="Selected conversations">
          <span className="mlx-s">{selRows.length} selected</span><span style={{ flex: 1 }} />
          <button type="button" className="mlx-btn" onClick={() => void act(selRows, 'read')}>Read</button>
          <button type="button" className="mlx-btn" onClick={() => void act(selRows, 'unread')}>Unread</button>
          <button type="button" className="mlx-btn" onClick={() => void act(selRows, 'flag')}>Flag</button>
          <button type="button" className="mlx-btn" onClick={() => { void act(selRows, 'archive'); setSelected(new Set()) }}>Archive</button>
          <button type="button" className="mlx-btn d" onClick={() => { void act(selRows, 'trash'); setSelected(new Set()) }}>Delete</button>
        </div> : <button type="button" className="mlx-fab" aria-label="Compose" title="Compose (c)" onClick={() => setCompose({ title: 'New message', account: unified ? '' : sel.account })}>{I.pen(18)}</button>}
      </> : null}

      {pane === 'thread' && open ? <ThreadView open={open} onBack={() => { setPane('list'); setOpen(null) }} onReply={reply}
        onAct={a => { void act([open], a); if (a === 'archive' || a === 'trash') { setPane('list'); setOpen(null) } }} /> : null}
      {pane === 'folders' && state ? <FoldersPane state={state} sel={sel} choose={choose} /> : null}
      {pane === 'queue' && state ? <QueuePane state={state} reload={load} toast={toast} /> : null}
      {pane === 'suppress' ? <SuppressionPane toast={toast} /> : null}
      {pane === 'settings' ? <div className="mlx-body mlx-pad">
        <AccountsEditor onChanged={() => { void load(); void fetchList() }} />
        {state ? <div className="mlx-s" style={{ marginTop: 8 }}>dsh-mail {state.version} · cache {state.cacheKind || 'not opened yet'} · agent sends: {state.confirmMode.mode}</div> : null}
      </div> : null}

      {compose && state ? <Composer state={state} init={compose} onClose={() => setCompose(null)} onSent={m => {
        setCompose(null)
        if (m && m.held) { setUndo(m); setTimeout(() => setUndo(u => (u && u.id === m.id ? null : u)), Math.max(1000, m.sendAt - Date.now())) }
        else toast(m)
        void load()
      }} /> : null}
      {undo ? <div className="mlx-toast" role="status">Sending... <button type="button" className="mlx-btn" style={{ marginLeft: 8, color: 'inherit' }} onClick={async () => { const id = undo.id; setUndo(null); try { await apiPost('/outbox/cancel', { id }); toast('Not sent.') } catch { toast('Too late: already sent.') } }}>Undo</button></div> : null}
      {toastMsg && !undo ? <div className="mlx-toast" role="status">{toastMsg}</div> : null}
    </div>
  )
}
