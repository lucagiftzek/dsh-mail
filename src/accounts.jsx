/**
 * dsh-mail browser half: AccountsEditor, shared by the DSH Settings "Mail"
 * section and the gear pane of the tab. Secrets come back from the host as
 * "__set__" (stored) or "" (empty) and are never shown; sending "__set__"
 * back keeps the stored value.
 */
import { useEffect, useState } from 'react'
import { apiGet, apiPost } from './api.js'

const TEMPLATES = {
  'imap-smtp': { receive: { protocol: 'imap', host: '', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: '', port: 465, security: 'tls' }, auth: { method: 'password' } },
  'pop3-smtp': { receive: { protocol: 'pop3', host: '', port: 995, security: 'tls', leaveOnServer: true }, send: { protocol: 'smtp', host: '', port: 465, security: 'tls' }, auth: { method: 'password' } },
  google: { receive: { protocol: 'imap', host: 'imap.gmail.com', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: 'smtp.gmail.com', port: 465, security: 'tls' }, auth: { method: 'app-password' } },
  local: { receive: { protocol: 'imap', host: '', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: '', port: 587, security: 'starttls' }, auth: { method: 'password' } },
  tzekos: { receive: { protocol: 'api' }, send: { protocol: 'api' }, auth: { method: 'bearer' }, api: { baseUrl: '' } },
  lettermint: { receive: { protocol: 'none' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { baseUrl: '' } },
  resend: { receive: { protocol: 'none' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { baseUrl: '' } },
  agentmail: { receive: { protocol: 'api' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { inbox: '', baseUrl: '' } },
}
const NOTES = {
  google: 'Turn on 2-Step Verification, create an app password (Google Account, Security, App passwords) and paste it below. OAuth sign-in arrives in the next release.',
  'pop3-smtp': 'POP3 has no server folders or flags: read state is kept locally. Messages are left on the server.',
  tzekos: 'Tzekos Mail webmail agent API: the base URL of the webmail and a service token (MAIL_AGENT_TOKEN), never a user password.',
  lettermint: 'Send only. API key from the Lettermint dashboard.',
  resend: 'Send only. API key from the Resend dashboard.',
  agentmail: 'API key and the inbox id.',
}

function blank(type) {
  return {
    id: '', label: '', type, enabled: true, address: '', displayName: '', defaultFrom: '', replyTo: '', signature: '',
    allowSelfSigned: false, passwordFile: '', passwordEnv: '',
    secrets: { password: '', apiKey: '' },
    agent: { allow: false, canRead: true, canSend: true, canMass: false, default: false },
    limits: { maxRecipients: 500 },
    ...structuredClone(TEMPLATES[type] || TEMPLATES['imap-smtp']),
  }
}

function Field({ label, hint, children }) {
  return <label className="mlx-field"><span>{label}</span>{children}{hint ? <em>{hint}</em> : null}</label>
}
function Check({ checked, onChange, children }) {
  return <label className="mlx-chk"><input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} /><span>{children}</span></label>
}
export function SecretInput({ value, onChange, placeholder }) {
  const set = value === '__set__'
  return <input className="mlx-in mlx-mono" type="password" autoComplete="new-password" placeholder={set ? 'saved (type to replace)' : (placeholder || '')} value={set ? '' : (value || '')} onChange={e => onChange(e.target.value || (set ? '__set__' : ''))} />
}

function Endpoint({ side, e, set, protocols }) {
  if (!e || !['imap', 'pop3', 'smtp'].includes(e.protocol)) return null
  return (
    <div>
      <div className="mlx-grid">
        {protocols ? <Field label={side === 'receive' ? 'Incoming' : 'Outgoing'}>
          <select className="mlx-in" value={e.protocol} onChange={ev => set(side + '.protocol', ev.target.value)}>{protocols.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select>
        </Field> : null}
        <Field label={(side === 'receive' ? e.protocol.toUpperCase() : 'SMTP') + ' host'}><input className="mlx-in mlx-mono" value={e.host || ''} onChange={ev => set(side + '.host', ev.target.value.trim())} placeholder={side === 'receive' ? 'imap.example.com' : 'smtp.example.com'} /></Field>
        <Field label="Port"><input className="mlx-in mlx-mono" type="number" value={e.port || ''} onChange={ev => set(side + '.port', Number(ev.target.value))} /></Field>
        <Field label="Security">
          <select className="mlx-in" value={e.security || 'tls'} onChange={ev => set(side + '.security', ev.target.value)}>
            <option value="tls">TLS (implicit)</option><option value="starttls">STARTTLS</option><option value="none">None (loopback only)</option>
          </select>
        </Field>
      </div>
    </div>
  )
}

function AccountForm({ initial, isNew, types, onDone, onCancel }) {
  const [a, setA] = useState(initial)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)
  const set = (path, v) => {
    const next = structuredClone(a)
    const keys = path.split('.')
    let o = next
    for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k] }
    o[keys[keys.length - 1]] = v
    setA(next); setMsg(null)
  }
  const t = a.type
  const mailProto = ['imap-smtp', 'pop3-smtp', 'google', 'local'].includes(t)
  async function test() {
    setBusy('test'); setMsg(null)
    try { const r = await apiPost('/accounts/test', { account: a, originalId: isNew ? undefined : initial.id }); setMsg({ tone: r.result.ok ? 'ok' : 'bad', steps: r.result.steps, text: r.result.ok ? 'Connection works. Capabilities: ' + r.result.capabilities.join(', ') : 'Test failed' }) }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  async function save() {
    setBusy('save'); setMsg(null)
    try { await apiPost('/accounts/save', { account: a, originalId: isNew ? undefined : initial.id }); onDone('Saved ' + a.id + '.') }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  async function remove() {
    if (typeof window !== 'undefined' && !window.confirm('Remove account ' + a.id + '? Its cache, drafts and pending queue entries are removed too. Mail on the server is not touched.')) return
    setBusy('remove')
    try { await apiPost('/accounts/remove', { id: initial.id }); onDone('Removed ' + initial.id + '.') }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  const typeInfo = (types || []).find(x => x.id === t)
  return (
    <div className="mlx-acc">
      {NOTES[t] ? <div className="mlx-s" style={{ marginBottom: 8 }}>{NOTES[t]}</div> : null}
      {typeInfo && typeInfo.unsupported ? <div className="mlx-note warn">{typeInfo.unsupported}</div> : null}
      <div className="mlx-grid">
        <Field label="Account id" hint={isNew ? 'a-z, 0-9 and -, used as the tool argument account' : 'cannot be changed'}><input className="mlx-in mlx-mono" disabled={!isNew} value={a.id} onChange={e => set('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="work" /></Field>
        <Field label="Label"><input className="mlx-in" value={a.label} onChange={e => set('label', e.target.value)} placeholder="Work mail" /></Field>
      </div>
      {t !== 'lettermint' && t !== 'resend' ? <div className="mlx-grid">
        <Field label="Email address"><input className="mlx-in" value={a.address} onChange={e => set('address', e.target.value.trim())} placeholder="me@example.com" /></Field>
        <Field label="Display name"><input className="mlx-in" value={a.displayName} onChange={e => set('displayName', e.target.value)} /></Field>
      </div> : null}
      {mailProto ? <>
        <Endpoint side="receive" e={a.receive} set={set} protocols={t === 'local' ? ['imap', 'pop3'] : null} />
        <Endpoint side="send" e={a.send} set={set} />
        <div className="mlx-grid">
          <Field label="Login" hint="Empty: the email address"><input className="mlx-in mlx-mono" value={(a.auth && a.auth.user) || ''} onChange={e => set('auth.user', e.target.value.trim())} /></Field>
          <Field label={t === 'google' ? 'App password' : 'Password'}><SecretInput value={a.secrets.password} onChange={v => set('secrets.password', v)} /></Field>
        </div>
        <details style={{ marginBottom: 8 }}>
          <summary className="mlx-s" style={{ cursor: 'pointer' }}>Password from a file or an environment variable, certificates</summary>
          <div className="mlx-grid" style={{ marginTop: 6 }}>
            <Field label="Password file"><input className="mlx-in mlx-mono" value={a.passwordFile || ''} onChange={e => set('passwordFile', e.target.value.trim())} placeholder="/path/to/secret" /></Field>
            <Field label="Password env var"><input className="mlx-in mlx-mono" value={a.passwordEnv || ''} onChange={e => set('passwordEnv', e.target.value.trim())} placeholder="MAIL_PASSWORD" /></Field>
          </div>
          <Check checked={a.allowSelfSigned} onChange={v => set('allowSelfSigned', v)}>Accept a self-signed certificate (only for your own server or a local bridge)</Check>
        </details>
      </> : null}
      {t === 'tzekos' ? <div className="mlx-grid">
        <Field label="Webmail base URL"><input className="mlx-in mlx-mono" value={(a.api && a.api.baseUrl) || ''} onChange={e => set('api.baseUrl', e.target.value.trim())} placeholder="https://mail.example.com" /></Field>
        <Field label="Service token"><SecretInput value={a.secrets.apiKey} onChange={v => set('secrets.apiKey', v)} /></Field>
      </div> : null}
      {['lettermint', 'resend', 'agentmail'].includes(t) ? <div className="mlx-grid">
        <Field label="API key"><SecretInput value={a.secrets.apiKey} onChange={v => set('secrets.apiKey', v)} /></Field>
        {t === 'agentmail' ? <Field label="Inbox"><input className="mlx-in mlx-mono" value={(a.api && a.api.inbox) || ''} onChange={e => set('api.inbox', e.target.value.trim())} /></Field> : null}
        <Field label="API base URL" hint="Empty: the provider default"><input className="mlx-in mlx-mono" value={(a.api && a.api.baseUrl) || ''} onChange={e => set('api.baseUrl', e.target.value.trim())} /></Field>
      </div> : null}
      <div className="mlx-grid">
        <Field label="Default From"><input className="mlx-in" value={a.defaultFrom} onChange={e => set('defaultFrom', e.target.value)} placeholder="Name <me@example.com>" /></Field>
        <Field label="Reply-To"><input className="mlx-in" value={a.replyTo} onChange={e => set('replyTo', e.target.value)} /></Field>
      </div>
      <Field label="Signature"><textarea className="mlx-in" rows={2} value={a.signature} onChange={e => set('signature', e.target.value)} /></Field>
      <div className="mlx-h" style={{ margin: '6px 0' }}>Agents</div>
      <Check checked={a.agent.allow} onChange={v => set('agent.allow', v)}>Agents may use this account</Check>
      {a.agent.allow ? <div className="mlx-flex" style={{ paddingLeft: 18 }}>
        <Check checked={a.agent.canRead} onChange={v => set('agent.canRead', v)}>read</Check>
        <Check checked={a.agent.canSend} onChange={v => set('agent.canSend', v)}>send</Check>
        <Check checked={a.agent.canMass} onChange={v => set('agent.canMass', v)}>mass send</Check>
        <Check checked={a.agent.default} onChange={v => set('agent.default', v)}>default account</Check>
      </div> : null}
      <div className="mlx-flex">
        <Check checked={a.enabled} onChange={v => set('enabled', v)}>Enabled</Check>
        <Check checked={a.isDefaultSender} onChange={v => set('isDefaultSender', v)}>Default sender in the composer</Check>
      </div>
      <Field label="Max recipients per message"><input className="mlx-in" type="number" style={{ maxWidth: 140 }} value={(a.limits && a.limits.maxRecipients) || 500} onChange={e => set('limits.maxRecipients', Number(e.target.value))} /></Field>
      {msg ? <div className={'mlx-note ' + msg.tone} style={{ margin: '8px 0' }}>
        <div>{msg.text}</div>
        {(msg.steps || []).map(s => <div key={s.step} className="mlx-s">{s.ok ? 'OK' : 'FAILED'} · {s.step}: {s.detail}</div>)}
      </div> : null}
      <div className="mlx-flex" style={{ marginTop: 6 }}>
        <button type="button" className="mlx-btn p" disabled={!!busy || !a.id} onClick={() => void save()}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
        <button type="button" className="mlx-btn" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing...' : 'Test connection'}</button>
        <button type="button" className="mlx-btn" disabled={!!busy} onClick={onCancel}>Cancel</button>
        <span style={{ flex: 1 }} />
        {!isNew ? <button type="button" className="mlx-btn d" disabled={!!busy} onClick={() => void remove()}>Remove</button> : null}
      </div>
    </div>
  )
}

const ADD_ORDER = ['imap-smtp', 'pop3-smtp', 'google', 'tzekos', 'lettermint', 'resend', 'agentmail', 'local']

export function AccountsEditor({ onChanged }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(null) // { account, isNew }
  const [note, setNote] = useState('')
  const [testing, setTesting] = useState({})
  const [glob, setGlob] = useState(null)
  const load = async () => { try { const r = await apiGet('/accounts'); setData(r); setGlob({ confirmMode: r.settings.agents.confirmMode || '', defaultProvider: r.settings.defaultProvider || '', retentionDays: r.settings.cache.retentionDays }); setErr('') } catch (e) { setErr(e.message) } }
  useEffect(() => { void load() }, [])
  if (!data) return <div className="mlx-pad">{err ? <div className="mlx-note bad">{err}</div> : 'Loading accounts...'}</div>
  const done = async (m) => { setEdit(null); setNote(m); await load(); if (onChanged) onChanged() }
  const testLegacy = async (id) => {
    setTesting(t => ({ ...t, [id]: { busy: true } }))
    try { const r = await apiPost('/accounts/test', { id }); setTesting(t => ({ ...t, [id]: r.result })) } catch (e) { setTesting(t => ({ ...t, [id]: { ok: false, steps: [{ step: 'test', ok: false, detail: e.message }] } })) }
  }
  const saveGlobal = async () => {
    try {
      const body = { defaultProvider: glob.defaultProvider, cache: { retentionDays: Number(glob.retentionDays) } }
      if (glob.confirmMode) body.agents = { confirmMode: glob.confirmMode }
      await apiPost('/settings', { settings: body }); setNote('Settings saved.'); await load()
    } catch (e) { setErr(e.message) }
  }
  const all = [...data.accounts, ...data.legacy]
  return (
    <div className="mlx-sec">
      {err ? <div className="mlx-note bad">{err}</div> : null}
      {note ? <div className="mlx-note ok">{note}</div> : null}
      {edit ? <AccountForm initial={edit.account} isNew={edit.isNew} types={data.types} onDone={m => void done(m)} onCancel={() => setEdit(null)} /> : <>
        {all.length === 0 ? <div className="mlx-empty">Add your first account: any IMAP or POP3 mailbox, Gmail with an app password, or a sending service.</div> : null}
        {data.accounts.map(a => (
          <div key={a.id} className="mlx-acc">
            <div className="mlx-flex">
              <span className="mlx-dot" style={{ background: a.color }} />
              <b>{a.label}</b><span className="mlx-s mlx-mono">{a.id}</span>
              <span className="mlx-s">{a.type}{a.address ? ' · ' + a.address : ''}</span>
              <span style={{ flex: 1 }} />
              {!a.enabled ? <span className="mlx-pill">disabled</span> : null}
              {a.agent.allow ? <span className="mlx-pill">agents</span> : null}
              <button type="button" className="mlx-btn" onClick={() => setEdit({ account: structuredClone(a), isNew: false })}>Edit</button>
            </div>
          </div>
        ))}
        {data.legacy.length ? <div className="mlx-note warn">
          <b>Legacy provider settings in use.</b> These accounts come from the v0.1 provider settings and the credential files, read only here. They keep working unchanged; converting them to editable accounts arrives in the next release.
        </div> : null}
        {data.legacy.map(a => (
          <div key={a.id} className="mlx-acc">
            <div className="mlx-flex">
              <span className="mlx-dot" style={{ background: a.color }} />
              <b>{a.label}</b><span className="mlx-s mlx-mono">{a.id}</span><span className="mlx-s">{a.type} · {a.capabilities.join(', ')}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="mlx-btn" disabled={testing[a.id] && testing[a.id].busy} onClick={() => void testLegacy(a.id)}>Test</button>
            </div>
            {testing[a.id] && testing[a.id].steps ? testing[a.id].steps.map(s => <div key={s.step} className="mlx-s">{s.ok ? 'OK' : 'FAILED'} · {s.step}: {s.detail}</div>) : null}
          </div>
        ))}
        <div className="mlx-flex" style={{ margin: '6px 0 12px' }}>
          <select className="mlx-in" style={{ width: 'auto' }} id="mlx-addtype" defaultValue="imap-smtp" aria-label="Account type">
            {ADD_ORDER.map(id => { const t = data.types.find(x => x.id === id); return t ? <option key={id} value={id}>{t.label}</option> : null })}
          </select>
          <button type="button" className="mlx-btn p" onClick={() => { const el = typeof document !== 'undefined' ? document.getElementById('mlx-addtype') : null; setEdit({ account: blank(el ? el.value : 'imap-smtp'), isNew: true }); setNote('') }}>Add account</button>
        </div>
        {glob ? <div className="mlx-acc">
          <b>Agents and cache</b>
          <div className="mlx-grid" style={{ marginTop: 6 }}>
            <Field label="Agent sends" hint={'Now: ' + data.confirmMode.mode + ' (' + data.confirmMode.source + ')'}>
              <select className="mlx-in" value={glob.confirmMode} onChange={e => setGlob({ ...glob, confirmMode: e.target.value })}>
                <option value="">Automatic</option><option value="all">Draft first, confirm every send</option><option value="reply-only">Send at once, draft replies only</option>
              </select>
            </Field>
            <Field label="Default account for tools">
              <select className="mlx-in" value={glob.defaultProvider} onChange={e => setGlob({ ...glob, defaultProvider: e.target.value })}>
                <option value="">Automatic</option>{all.map(a => <option key={a.id} value={a.id}>{a.id}</option>)}
              </select>
            </Field>
            <Field label="Keep cached text (days)" hint="0 = headers only, -1 = keep"><input className="mlx-in" type="number" value={glob.retentionDays} onChange={e => setGlob({ ...glob, retentionDays: e.target.value })} /></Field>
          </div>
          <button type="button" className="mlx-btn" onClick={() => void saveGlobal()}>Save</button>
        </div> : null}
      </>}
    </div>
  )
}
