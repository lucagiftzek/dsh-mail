/**
 * dsh-mail — browser half.
 *
 * The Mail sidebar tab: provider status, send a test email, the email queue
 * (pending, sent, failed, cancelled), settings for all providers.
 *
 * Follows the same pattern as dsh-hpc:
 *  - The client is never the authority; the host recomputes everything.
 *  - Credentials are never persisted in the browser; the settings form sends
 *    them over a same-origin POST and the host stores them in settings.yaml.
 *  - Styling uses the harness design tokens (--dsh-alias-*) so the tab reads
 *    as part of the GUI in either theme.
 *
 * Purity: no @deepseek-ai/* value imports.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const TAB_ID = 'dsh-mail:main'
const API = '/dsh-mail/api'
const POLL_MS = 15000

// -- helpers ----------------------------------------------------------------

function fmtAge(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return 'unknown'
  const s = Math.max(0, Math.round(Number(seconds)))
  if (s < 90) return s + 's ago'
  if (s < 5400) return Math.round(s / 60) + 'm ago'
  if (s < 172800) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

function fmtWhen(unix) {
  if (!Number.isFinite(Number(unix))) return '--'
  return new Date(Number(unix) * 1000).toLocaleString()
}

const CSS = [
  '.mlx{--ok:var(--dsw-alias-state-success-primary,#2e9e5b);--warn:var(--dsw-alias-state-warn-primary,#c98a14);',
  '  --bad:var(--dsw-alias-state-error-primary,#cf3b3b);--brand:var(--dsw-alias-brand-primary,#4d6bfe);',
  '  --ink:var(--dsw-alias-label-primary,inherit);--ink2:var(--dsw-alias-label-secondary,inherit);',
  '  --ink3:var(--dsw-alias-label-tertiary,inherit);--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));',
  '  --line1:var(--dsw-alias-border-l1,rgba(128,128,128,.18));--l1:var(--dsw-alias-bg-layer-1,transparent);',
  '  --l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));--hov:var(--dsh-alias-interactive-bg-hover,rgba(128,128,128,.12));',
  '  display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font:inherit;font-size:13px;color:var(--ink)}',
  '.mlx *{box-sizing:border-box}',
  '.mlx-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);flex:0 0 auto}',
  '.mlx-body{flex:1;min-height:0;overflow-y:auto;padding:10px 10px 24px}',
  '.mlx-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);',
  '  background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
  '.mlx-btn:hover:not(:disabled){background:var(--hov)}',
  '.mlx-btn:disabled{opacity:.45;cursor:notallowed}',
  '.mlx-btn.p{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--brand));color:#fff;font-weight:600}',
  '.mlx-btn.d{border-color:var(--bad);color:var(--bad)}',
  '.mlx-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--l2);width:fit-content;margin-bottom:10px}',
  '.mlx-seg button{font:inherit;font-size:12px;padding:3px 9px;border:0;border-radius:6px;background:transparent;color:var(--ink2);cursor:pointer}',
  '.mlx-seg button[aria-selected=true]{background:var(--l1);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line1)}',
  '.mlx-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin-bottom:10px}',
  '.mlx-card{border:1px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--l1);min-width:0}',
  '.mlx-k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}',
  '.mlx-v{font-size:20px;font-weight:650;line-height:1.25}',
  '.mlx-s{font-size:11px;color:var(--ink3)}',
  '.mlx-note{border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:9px 11px;margin:0 0 10px;line-height:1.5;background:var(--l1)}',
  '.mlx-note.bad{border-left-color:var(--bad)}.mlx-note.warn{border-left-color:var(--warn)}.mlx-note.ok{border-left-color:var(--ok)}',
  '.mlx-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin:16px 0 6px}',
  '.mlx-row{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--line1);border-radius:7px;margin-bottom:5px;background:var(--l1)}',
  '.mlx-row:hover{background:var(--hov)}',
  '.mlx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
  '.mlx-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mlx-pill{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;font-weight:600}',
  '.mlx-empty{color:var(--ink3);padding:10px;border:1px dashed var(--line);border-radius:8px;line-height:1.5}',
  '.mlx-in{font:inherit;font-size:12px;width:100%;padding:6px 8px;border-radius:7px;border:1px solid var(--line);background:transparent;color:inherit}',
  '.mlx-in:focus{outline:2px solid var(--brand);outline-offset:-1px}',
  '.mlx-flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.mlx-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}',
  '.mlx-pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;',
  '  background:var(--l2);border:1px solid var(--line1);border-radius:7px;padding:8px 10px;overflow:auto;max-height:260px;white-space:pre;margin:6px 0}',
  '.mlx-foot{margin-top:18px;padding-top:10px;border-top:1px solid var(--line);font-size:11px;color:var(--ink3);line-height:1.6}',
].join('\n')

// -- data hook -------------------------------------------------------------

function useMail(visible) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const token = useRef(null)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const mint = useCallback(async () => {
    const r = await fetch(API + '/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error('could not mint token (HTTP ' + r.status + ')')
    const j = await r.json()
    token.current = j.token
    return j.token
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetch(API + '/state', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      if (alive.current) { setState(j); setError('') }
    } catch (e) { if (alive.current) setError(String(e.message || e)) }
    finally { if (alive.current) setBusy(false) }
  }, [])

  const post = useCallback(async (path, body) => {
    const send = async (tok) => fetch(API + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-mail-token': tok },
      body: JSON.stringify(body || {}),
    })
    let tok = token.current || await mint()
    let r = await send(tok)
    if (r.status === 403) { tok = await mint(); r = await send(tok) }
    let j = null
    try { j = await r.json() } catch { j = { ok: false, error: 'HTTP ' + r.status } }
    await load()
    return j
  }, [mint, load])

  useEffect(() => {
    if (visible === false) return undefined
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [visible, load])

  return { state, error, busy, load, post }
}

// -- sections ---------------------------------------------------------------

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'queue', label: 'Queue' },
  { id: 'send', label: 'Send' },
  { id: 'settings', label: 'Settings' },
]

function MailView({ visible }) {
  const { state, error, busy, load, post } = useMail(visible)
  const [section, setSection] = useState('overview')
  const [working, setWorking] = useState(false)

  const providers = state && state.providers || {}
  const queue = state && state.queue || []
  const counts = state && state.queueCounts || { pending: 0, sent: 0, failed: 0, cancelled: 0 }

  const enabledCount = Object.values(providers).filter(p => p.enabled).length

  return (
    <div className="mlx">
      <style>{CSS}</style>
      <div className="mlx-bar">
        <span className="mlx-dot" style={{ background: enabledCount ? 'var(--ok)' : 'var(--bad)' }} />
        <span style={{ fontWeight: 650 }}>Mail</span>
        <span className="mlx-s mlx-mono">{enabledCount} provider{enabledCount !== 1 ? 's' : ''}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="mlx-btn" onClick={() => void load()} aria-busy={busy ? 'true' : 'false'}>reload</button>
      </div>

      <div className="mlx-body">
        {error ? (
          <div className="mlx-note bad">
            <strong>Could not read the Mail state route.</strong>
            <div className="mlx-mono" style={{ marginTop: 4 }}>{error}</div>
            <div className="mlx-s" style={{ marginTop: 4 }}>
              A 404 means the plugin row is not mounted; a 403 means the trust fence blocked the request.
            </div>
          </div>
        ) : null}

        {!state && !error ? <div className="mlx-empty">Loading mail state…</div> : null}

        <div className="mlx-seg">
          {SECTIONS.map(s => (
            <button key={s.id} type="button" aria-selected={section === s.id} onClick={() => setSection(s.id)}>
              {s.label}
              {s.id === 'queue' && counts.pending ? ' (' + counts.pending + ')' : ''}
            </button>
          ))}
        </div>

        {section === 'overview' && state ? (
          <div>
            <div className="mlx-cards">
              <div className="mlx-card"><div className="mlx-k">Providers</div><div className="mlx-v">{enabledCount}</div><div className="mlx-s">of {Object.keys(providers).length} configured</div></div>
              <div className="mlx-card"><div className="mlx-k">Pending</div><div className="mlx-v">{counts.pending}</div><div className="mlx-s">queued + scheduled</div></div>
              <div className="mlx-card"><div className="mlx-k">Sent</div><div className="mlx-v">{counts.sent}</div><div className="mlx-s">delivered</div></div>
              <div className="mlx-card"><div className="mlx-k">Failed</div><div className="mlx-v" style={{ color: counts.failed ? 'var(--bad)' : undefined }}>{counts.failed}</div><div className="mlx-s">errors</div></div>
            </div>
            <div className="mlx-h">Providers</div>
            {Object.entries(providers).map(([id, p]) => (
              <div className="mlx-row" key={id}>
                <span className="mlx-pill" style={{ color: p.enabled ? 'var(--ok)' : 'var(--bad)' }}>{p.enabled ? 'on' : 'off'}</span>
                <span className="mlx-grow"><strong>{id}</strong> <span className="mlx-s">{p.name}</span></span>
              </div>
            ))}
            <div className="mlx-foot">
              <strong>Agents can send, you review.</strong> Single emails go out immediately; mass sends and scheduled emails appear in the Queue tab for review.
              Configure credentials in Settings.
            </div>
          </div>
        ) : null}

        {section === 'queue' && state ? (
          <div>
            {queue.length === 0 ? (
              <div className="mlx-empty">
                <strong>Queue is empty.</strong> Scheduled and manually-queued emails land here. Agents can queue with <span className="mlx-mono">mail_send_later</span> or <span className="mlx-mono">mail_mass_send</span> with queueOnly.
              </div>
            ) : queue.map(q => (
              <QueueRow key={q.id} q={q} post={post} onBusy={setWorking} />
            ))}
          </div>
        ) : null}

        {section === 'send' && state ? (
          <SendPanel state={state} post={post} onBusy={setWorking} />
        ) : null}

        {section === 'settings' && state ? (
          <SettingsPanel state={state} post={post} onBusy={setWorking} />
        ) : null}
      </div>
    </div>
  )
}

function QueueRow({ q, post, onBusy }) {
  const [result, setResult] = useState(null)
  const tone = q.status === 'sent' ? 'var(--ok)' : q.status === 'failed' ? 'var(--bad)' : q.status === 'cancelled' ? 'var(--ink3)' : 'var(--warn)'

  const act = async (kind) => {
    onBusy(true)
    try {
      const r = kind === 'send' ? await post('/queue/send', { id: q.id }) : await post('/queue/cancel', { id: q.id })
      setResult(r)
    } finally { onBusy(false) }
  }

  return (
    <div className="mlx-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="mlx-flex" style={{ justifyContent: 'space-between' }}>
        <div className="mlx-flex">
          <span className="mlx-pill" style={{ color: tone }}>{q.status}</span>
          <span className="mlx-grow"><strong>{q.name}</strong></span>
          <span className="mlx-s mlx-mono">{q.id}</span>
        </div>
      </div>
      <div className="mlx-s" style={{ marginTop: 4 }}>
        via <strong>{q.provider}</strong> · {q.msg.to || (q.csvData ? q.csvData.rows.length + ' recipients' : '')} · {fmtWhen(q.created_at)}
      </div>
      {q.msg.subject ? <div className="mlx-s" style={{ marginTop: 2 }}>Subject: {q.msg.subject}</div> : null}
      {q.sendAt ? <div className="mlx-s" style={{ marginTop: 2 }}>Scheduled for: {fmtWhen(q.sendAt)}</div> : null}
      {q.lastError ? <div className="mlx-s" style={{ color: 'var(--bad)', marginTop: 2 }}>{q.lastError}</div> : null}
      {q.sentMessageId ? <div className="mlx-s mlx-mono" style={{ marginTop: 2 }}>Message ID: {q.sentMessageId}</div> : null}
      {result && !result.ok ? <div className="mlx-s" style={{ color: 'var(--bad)', marginTop: 4 }}>{result.error}</div> : null}
      {(q.status === 'queued' || q.status === 'scheduled' || q.status === 'failed') ? (
        <div className="mlx-flex" style={{ marginTop: 6 }}>
          <button type="button" className="mlx-btn p" disabled={q.status === 'sent'} onClick={() => void act('send')}>Send now</button>
          <button type="button" className="mlx-btn d" disabled={q.status === 'sent'} onClick={() => void act('cancel')}>Cancel</button>
        </div>
      ) : null}
    </div>
  )
}

function SendPanel({ state, post, onBusy }) {
  const [provider, setProvider] = useState(state.settings?.defaultProvider || 'lettermint')
  const [from, setFrom] = useState(state.settings?.defaultFrom || '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)

  const send = async () => {
    onBusy(true); setResult(null)
    try { const r = await post('/send', { provider, from, to, subject, text }); setResult(r) }
    finally { onBusy(false) }
  }

  const enabledProviders = Object.entries(state.providers || {}).filter(([, p]) => p.enabled)
  return (
    <div>
      <div className="mlx-h">Send a test email</div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Provider</label>
        <select className="mlx-in" value={provider} onChange={e => setProvider(e.target.value)}>
          {enabledProviders.length ? enabledProviders.map(([id]) => <option key={id} value={id}>{id}</option>)
            : <option value="" disabled>No providers configured</option>}
        </select>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>From</label>
        <input className="mlx-in" value={from} onChange={e => setFrom(e.target.value)} placeholder="sender@example.com" />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>To</label>
        <input className="mlx-in" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Subject</label>
        <input className="mlx-in" value={subject} onChange={e => setSubject(e.target.value)} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Body</label>
        <textarea className="mlx-in" rows={5} value={text} onChange={e => setText(e.target.value)} />
      </div>
      <button type="button" className="mlx-btn p" disabled={!to || !subject || !text} onClick={() => void send()}>Send</button>
      {result ? (
        <div className="mlx-note" style={{ marginTop: 10, borderLeftColor: result.ok ? 'var(--ok)' : 'var(--bad)' }}>
          {result.ok ? 'Sent: ' + (result.messageId || '(no ID)') : 'Failed: ' + (result.error || 'unknown')}
        </div>
      ) : null}
    </div>
  )
}

function SettingsPanel({ state, post, onBusy }) {
  const s = state.settings || {}
  const [form, setForm] = useState({ ...s })
  const [result, setResult] = useState(null)

  const save = async () => {
    onBusy(true); setResult(null)
    try {
      const r = await fetch(API + '/settings', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-mail' },
        body: JSON.stringify(form),
      })
      const j = await r.json()
      setResult(j)
    } finally { onBusy(false) }
  }

  const update = (path, value) => {
    setForm(f => {
      const next = { ...f }
      const parts = path.split('.')
      let cur = next
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...cur[parts[i]] }
        cur = cur[parts[i]]
      }
      cur[parts[parts.length - 1]] = value
      return next
    })
  }

  const providerIds = Object.keys(s.providers || {})

  return (
    <div>
      <div className="mlx-h">General</div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Default provider</label>
        <select className="mlx-in" value={form.defaultProvider} onChange={e => update('defaultProvider', e.target.value)}>
          {providerIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Default From</label>
        <input className="mlx-in" value={form.defaultFrom} onChange={e => update('defaultFrom', e.target.value)} placeholder="me@example.com" />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Default Reply-To</label>
        <input className="mlx-in" value={form.defaultReplyTo} onChange={e => update('defaultReplyTo', e.target.value)} />
      </div>

      {providerIds.map(id => (
        <div key={id}>
          <div className="mlx-h">{id}</div>
          {id === 'lettermint' ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>API Key</label>
                <input className="mlx-in" type="password" value={form.providers?.lettermint?.lettermintApiKey || ''} onChange={e => update('providers.lettermint.lettermintApiKey', e.target.value)} placeholder="x-lettermint-token" />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Base URL</label>
                <input className="mlx-in" value={form.providers?.lettermint?.lettermintBaseURL || ''} onChange={e => update('providers.lettermint.lettermintBaseURL', e.target.value)} />
              </div>
            </>
          ) : null}
          {id === 'agentmail' ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>API Key</label>
                <input className="mlx-in" type="password" value={form.providers?.agentmail?.agentmailApiKey || ''} onChange={e => update('providers.agentmail.agentmailApiKey', e.target.value)} placeholder="Bearer token" />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Inbox</label>
                <input className="mlx-in" value={form.providers?.agentmail?.agentmailInbox || ''} onChange={e => update('providers.agentmail.agentmailInbox', e.target.value)} placeholder="inbox name" />
              </div>
            </>
          ) : null}
          {id === 'resend' ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>API Key</label>
                <input className="mlx-in" type="password" value={form.providers?.resend?.resendApiKey || ''} onChange={e => update('providers.resend.resendApiKey', e.target.value)} placeholder="re_xxxxxxxx" />
              </div>
            </>
          ) : null}
          {['ovh', 'smtp', 'local'].includes(id) ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>SMTP Host</label>
                <input className="mlx-in" value={form.providers?.[id]?.smtpHost || ''} onChange={e => update('providers.' + id + '.smtpHost', e.target.value)} placeholder={id === 'ovh' ? 'ssl0.ovh.net' : 'smtp.example.com'} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>SMTP Port</label>
                <input className="mlx-in" type="number" value={form.providers?.[id]?.smtpPort || 587} onChange={e => update('providers.' + id + '.smtpPort', Number(e.target.value))} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>SMTP User</label>
                <input className="mlx-in" value={form.providers?.[id]?.smtpUser || ''} onChange={e => update('providers.' + id + '.smtpUser', e.target.value)} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>SMTP Password</label>
                <input className="mlx-in" type="password" value={form.providers?.[id]?.smtpPass || ''} onChange={e => update('providers.' + id + '.smtpPass', e.target.value)} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>From address</label>
                <input className="mlx-in" value={form.providers?.[id]?.smtpFrom || ''} onChange={e => update('providers.' + id + '.smtpFrom', e.target.value)} placeholder="me@example.com" />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>SSL/TLS</label>
                <input type="checkbox" checked={form.providers?.[id]?.smtpSecure || false} onChange={e => update('providers.' + id + '.smtpSecure', e.target.checked)} />
              </div>
            </>
          ) : null}
        </div>
      ))}

      <div className="mlx-h">Limits</div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Max recipients (per mass send)</label>
        <input className="mlx-in" type="number" value={form.maxRecipients || 500} onChange={e => update('maxRecipients', Number(e.target.value))} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Min delay between mass-send emails (ms)</label>
        <input className="mlx-in" type="number" value={form.minDelayMs || 500} onChange={e => update('minDelayMs', Number(e.target.value))} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label className="mlx-s" style={{ display: 'block', marginBottom: 3 }}>Max delay between mass-send emails (ms)</label>
        <input className="mlx-in" type="number" value={form.maxDelayMs || 60000} onChange={e => update('maxDelayMs', Number(e.target.value))} />
      </div>

      <button type="button" className="mlx-btn p" onClick={() => void save()}>Save settings</button>
      {result ? (
        <div className="mlx-note" style={{ marginTop: 10, borderLeftColor: result.ok ? 'var(--ok)' : 'var(--bad)' }}>
          {result.ok ? 'Settings saved.' : 'Failed: ' + (result.error || 'unknown')}
        </div>
      ) : null}
    </div>
  )
}

const icon = (size) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.5" />
    <path d="M2 4l6 4.5L14 4" strokeLinecap="round" />
  </svg>
)

export const inject = ['betterSidebar']

export function apply(ctx) {
  if (!ctx.betterSidebar || typeof ctx.betterSidebar.registerTab !== 'function') {
    console.error('[dsh-mail] ctx.betterSidebar.registerTab is unavailable; Mail tab not registered')
    return
  }
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title: 'Mail',
    order: 91,
    single: true,
    icon,
    component: (props) => <MailView visible={props.visible} />,
  }), 'dsh-mail: register the Mail sidebar tab')
}
