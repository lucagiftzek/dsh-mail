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
  google: { receive: { protocol: 'imap', host: 'imap.gmail.com', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: 'smtp.gmail.com', port: 465, security: 'tls' }, auth: { method: 'app-password' }, oauth: { clientId: '' } },
  microsoft: { receive: { protocol: 'imap', host: 'outlook.office365.com', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: 'smtp.office365.com', port: 587, security: 'starttls' }, auth: { method: 'oauth2' }, oauth: { clientId: '', tenant: 'common', sendMode: 'auto' } },
  local: { receive: { protocol: 'imap', host: '', port: 993, security: 'tls' }, send: { protocol: 'smtp', host: '', port: 587, security: 'starttls' }, auth: { method: 'password' } },
  tzekos: { receive: { protocol: 'api' }, send: { protocol: 'api' }, auth: { method: 'bearer' }, api: { baseUrl: '' } },
  lettermint: { receive: { protocol: 'none' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { baseUrl: '' } },
  resend: { receive: { protocol: 'none' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { baseUrl: '' } },
  agentmail: { receive: { protocol: 'api' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { inbox: '', baseUrl: '' } },
  sendgrid: { receive: { protocol: 'none' }, send: { protocol: 'api' }, auth: { method: 'api-key' }, api: { baseUrl: '' }, inbound: { enabled: false } },
}
const NOTES = {
  sendgrid: 'Twilio SendGrid: an API key with Mail Send permission and a verified sender. EU data residency: base URL https://api.eu.sendgrid.com. Inbound Parse (receiving) is optional and off by default.',
  google: 'Simplest: an app password (needs 2-Step Verification; Google Account, Security, App passwords). For Workspace accounts without app passwords, use OAuth2 with your own Google Cloud OAuth client.',
  microsoft: 'Microsoft only accepts OAuth2 for IMAP and SMTP. You register your own app in Microsoft Entra (free) and connect once.',
  'pop3-smtp': 'POP3 has no server folders or flags: read state is kept locally. Messages are left on the server.',
  tzekos: 'Tzekos Mail webmail agent API: the base URL of the webmail and a service token (MAIL_AGENT_TOKEN), never a user password.',
  lettermint: 'Send only. API key from the Lettermint dashboard.',
  resend: 'Send only. API key from the Resend dashboard.',
  agentmail: 'API key and the inbox id.',
}

/** A new account pre-filled from a server preset (hosts, ports, security, quirks). */
export function fromPreset(p) {
  const type = p.type || 'imap-smtp'
  const a = blank(type)
  a.label = p.label
  a.preset = p.id
  if (p.receive && p.receive.imap) a.receive = { protocol: 'imap', ...p.receive.imap }
  else if (p.receive && p.receive.pop3) a.receive = { protocol: 'pop3', ...p.receive.pop3, leaveOnServer: true }
  if (p.send && p.send.host !== undefined) a.send = { protocol: 'smtp', ...p.send }
  if (p.allowSelfSigned) a.allowSelfSigned = true
  if (p.auth === 'app-password' && type === 'google') a.auth = { method: 'app-password' }
  return a
}

function blank(type) {
  return {
    id: '', label: '', type, enabled: true, address: '', displayName: '', defaultFrom: '', replyTo: '', signature: '',
    allowSelfSigned: false, passwordFile: '', passwordEnv: '',
    secrets: { password: '', apiKey: '', oauthClientSecret: '' },
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
      {e.security === 'none' ? <div className="mlx-note warn">No encryption: the password and mail travel in clear. Allowed only to a loopback host (a local relay or bridge on this machine).</div> : null}
    </div>
  )
}

const HELP = {
  google: [
    'Google Cloud console (console.cloud.google.com): create or pick a project.',
    'APIs and Services, OAuth consent screen: user type External (or Internal for a Workspace organisation), add your address as a test user while testing.',
    'Set the publishing status to "In production". In "Testing" Google expires refresh tokens after 7 days and you would have to reconnect every week. An unverified app shows a warning screen on consent; that is fine for your own use.',
    'Credentials, Create credentials, OAuth client ID, type "Web application". Authorized redirect URI: the address shown below (Google requires https, or http://localhost for a local DSH).',
    'Scope used: https://mail.google.com/ (IMAP and SMTP). Copy the client ID and client secret here, Save, then Connect.',
  ],
  microsoft: [
    'Microsoft Entra admin center (entra.microsoft.com), App registrations, New registration. Supported account types: "any organizational directory and personal Microsoft accounts" (tenant common), or only your organisation (put its tenant id or domain below).',
    'Authentication, Add a platform, Web, redirect URI: the address shown below. For the device code sign-in (DSH without public https), also turn on "Allow public client flows".',
    'API permissions, Add a permission, Microsoft Graph, Delegated: offline_access, IMAP.AccessAsUser.All, SMTP.Send and Mail.Send (Mail.Send is for the Graph fallback). Work or school tenants may need an administrator to grant consent.',
    'Certificates and secrets, New client secret: paste its Value below (leave empty for a public client that only uses the device code).',
    'If your organisation disabled SMTP AUTH for the mailbox (error 5.7.139), keep "Send via: automatic" or choose "Microsoft Graph": mail then goes through Graph sendMail and lands in Sent Items.',
  ],
}

/** OAuth2 setup + connection panel for Google and Microsoft accounts. */
function OAuthPanel({ a, set, isNew, initial, saveFirst }) {
  const [uri, setUri] = useState('')
  const [st, setSt] = useState(initial.oauthStatus || null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [dev, setDev] = useState(null)
  const refresh = async () => { if (!a.id || isNew) return; try { const r = await apiGet('/oauth/status', { account: a.id }); setSt(r.status); if (r.status.device) setDev(r.status.device) } catch {} }
  useEffect(() => { apiGet('/oauth/redirect-uri').then(r => setUri(r.redirectUri)).catch(() => {}) }, [])
  useEffect(() => {
    const on = ev => { if (ev && ev.data && ev.data.type === 'dsh-mail-oauth') void refresh() }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [a.id])
  useEffect(() => { if (!dev || dev.status !== 'pending') return undefined; const t = setInterval(() => void refresh(), 3000); return () => clearInterval(t) }, [dev && dev.status])
  async function connect() {
    setErr(''); setBusy('connect')
    const w = window.open('about:blank', 'dsh-mail-oauth', 'width=520,height=700')
    try {
      await saveFirst()
      const r = await apiPost('/oauth/start', { account: a.id })
      if (w) w.location.href = r.url
      else setErr('The pop-up was blocked. Allow pop-ups for this site and press Connect again.')
    } catch (e) { if (w) w.close(); setErr(e.message) } finally { setBusy('') }
  }
  async function device() {
    setErr(''); setBusy('device')
    try { await saveFirst(); const r = await apiPost('/oauth/device/start', { account: a.id }); setDev({ status: 'pending', userCode: r.userCode, verificationUri: r.verificationUri, expiresAt: r.expiresAt }) }
    catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect ' + a.id + '? The stored tokens are deleted' + (a.type === 'google' ? ' and revoked at Google.' : '.'))) return
    setBusy('revoke')
    try { const r = await apiPost('/oauth/revoke', { account: a.id }); setSt({ connected: false, needsReauth: false }); setDev(null); if (r.note) setErr(r.note) } catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  const help = HELP[a.type] || []
  return (
    <div className="mlx-acc" style={{ background: 'var(--l2)' }}>
      <b>OAuth2 sign-in</b>
      <details style={{ margin: '6px 0' }}>
        <summary className="mlx-s" style={{ cursor: 'pointer' }}>How to create your own {a.type === 'google' ? 'Google' : 'Microsoft'} OAuth app (step by step)</summary>
        <ol className="mlx-s" style={{ paddingLeft: 18, lineHeight: 1.55 }}>{help.map((h, i) => <li key={i}>{h}</li>)}</ol>
      </details>
      <Field label="Redirect URI to register" hint="Copy it exactly. Set a fixed public base in Settings (oauth.redirectBaseUrl) if this shows the wrong host.">
        <div className="mlx-flex"><input className="mlx-in mlx-mono" readOnly value={uri} style={{ flex: 1 }} onFocus={e => e.target.select()} /><button type="button" className="mlx-btn" onClick={() => { try { void navigator.clipboard.writeText(uri) } catch {} }}>Copy</button></div>
      </Field>
      <div className="mlx-grid">
        <Field label="Client ID"><input className="mlx-in mlx-mono" value={(a.oauth && a.oauth.clientId) || ''} onChange={e => set('oauth.clientId', e.target.value.trim())} /></Field>
        <Field label="Client secret"><SecretInput value={a.secrets.oauthClientSecret} onChange={v => set('secrets.oauthClientSecret', v)} /></Field>
      </div>
      {a.type === 'microsoft' ? <div className="mlx-grid">
        <Field label="Tenant" hint="common, organizations, consumers, your domain or tenant id"><input className="mlx-in mlx-mono" value={(a.oauth && a.oauth.tenant) || ''} onChange={e => set('oauth.tenant', e.target.value.trim())} placeholder="common" /></Field>
        <Field label="Send via">
          <select className="mlx-in" value={(a.oauth && a.oauth.sendMode) || 'auto'} onChange={e => set('oauth.sendMode', e.target.value)}>
            <option value="auto">Automatic (SMTP, Graph when SMTP AUTH is off)</option><option value="smtp">SMTP only</option><option value="graph">Microsoft Graph only</option>
          </select>
        </Field>
      </div> : null}
      <div className="mlx-flex" style={{ margin: '4px 0' }}>
        <span className="mlx-dot" style={{ background: st && st.connected ? 'var(--ok)' : st && st.needsReauth ? 'var(--warn)' : 'var(--ink3)' }} />
        <span className="mlx-s" style={{ flex: 1 }}>{st && st.connected ? 'Connected' + (st.user ? ' as ' + st.user : '') : st && st.needsReauth ? 'Needs to reconnect: ' + (st.reason || '') : 'Not connected'}</span>
      </div>
      <div className="mlx-flex">
        <button type="button" className="mlx-btn p" disabled={!!busy || !a.id || !(a.oauth && a.oauth.clientId)} onClick={() => void connect()}>{busy === 'connect' ? 'Opening...' : st && (st.connected || st.needsReauth) ? 'Reconnect' : 'Connect'}</button>
        {a.type === 'microsoft' ? <button type="button" className="mlx-btn" disabled={!!busy || !a.id || !(a.oauth && a.oauth.clientId)} onClick={() => void device()}>Use a device code</button> : null}
        {st && (st.connected || st.needsReauth) ? <button type="button" className="mlx-btn d" disabled={!!busy} onClick={() => void disconnect()}>Disconnect</button> : null}
      </div>
      {dev && dev.status === 'pending' ? <div className="mlx-note warn" style={{ margin: '8px 0 0' }}>Open <a href={dev.verificationUri} target="_blank" rel="noreferrer noopener">{dev.verificationUri}</a> on any device and enter the code <b className="mlx-mono">{dev.userCode}</b>. This page updates when you are done.</div> : null}
      {dev && dev.status === 'failed' ? <div className="mlx-note bad" style={{ margin: '8px 0 0' }}>{dev.error}</div> : null}
      {err ? <div className="mlx-note bad" style={{ margin: '8px 0 0' }}>{err}</div> : null}
    </div>
  )
}

function SendgridInbound({ a, set, saved }) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  async function gen() {
    setErr('')
    try { const r = await apiPost('/accounts/webhook-secret', { account: a.id }); setUrl(location.origin + r.path) } catch (e) { setErr(e.message) }
  }
  return (
    <div className="mlx-acc" style={{ background: 'var(--l2)' }}>
      <Check checked={a.inbound && a.inbound.enabled} onChange={v => set('inbound.enabled', v)}>Receive mail through SendGrid Inbound Parse (advanced, needs a public https address)</Check>
      {a.inbound && a.inbound.enabled ? <>
        <div className="mlx-s" style={{ margin: '4px 0' }}>In SendGrid: Settings, Inbound Parse, add your receiving domain (MX records to mx.sendgrid.net) and paste the URL below as the destination; tick "POST the raw, full MIME message". Incoming mail is only stored in the local cache; it never triggers agent actions.</div>
        <button type="button" className="mlx-btn" disabled={!saved} onClick={() => void gen()}>{a.secrets.webhookSecret === '__set__' ? 'Generate a new webhook URL' : 'Generate the webhook URL'}</button>
        {!saved ? <span className="mlx-s"> Save the account first.</span> : null}
        {url ? <Field label="Webhook URL (shown once; it contains the secret)"><input className="mlx-in mlx-mono" readOnly value={url} onFocus={e => e.target.select()} /></Field> : null}
        {err ? <div className="mlx-note bad">{err}</div> : null}
      </> : null}
    </div>
  )
}

function AccountForm({ initial, isNew, types, presets, onDone, onCancel }) {
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
  const mailProto = ['imap-smtp', 'pop3-smtp', 'google', 'microsoft', 'local'].includes(t)
  const oauth = (t === 'google' && a.auth.method === 'oauth2') || t === 'microsoft'
  const [saved, setSaved] = useState(!isNew)
  /** Save silently (used by Connect, which needs the stored account). */
  async function saveFirst() {
    await apiPost('/accounts/save', { account: a, originalId: saved ? a.id : undefined })
    setSaved(true)
  }
  async function test() {
    setBusy('test'); setMsg(null)
    try { const r = await apiPost('/accounts/test', { account: a, originalId: saved ? a.id : undefined }); setMsg({ tone: r.result.ok ? 'ok' : 'bad', steps: r.result.steps, text: r.result.ok ? 'Connection works. Capabilities: ' + r.result.capabilities.join(', ') : 'Test failed' }) }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  async function save() {
    setBusy('save'); setMsg(null)
    try { await apiPost('/accounts/save', { account: a, originalId: saved ? a.id : undefined }); onDone('Saved ' + a.id + '.') }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  async function remove() {
    if (typeof window !== 'undefined' && !window.confirm('Remove account ' + a.id + '? Its cache, drafts and pending queue entries are removed too. Mail on the server is not touched.')) return
    setBusy('remove')
    try { await apiPost('/accounts/remove', { id: initial.id }); onDone('Removed ' + initial.id + '.') }
    catch (e) { setMsg({ tone: 'bad', text: e.message }) } finally { setBusy('') }
  }
  const typeInfo = (types || []).find(x => x.id === t)
  const presetInfo = a.preset && presets ? presets.find(p => p.id === a.preset) : null
  return (
    <div className="mlx-acc">
      {presetInfo ? <div className="mlx-note" style={{ margin: '0 0 8px' }}>
        <div className="mlx-flex"><b>{presetInfo.label}</b><span className="mlx-pill">{presetInfo.region}</span>{presetInfo.verified ? <span className="mlx-pill" style={{ color: 'var(--ok)' }}>servers checked</span> : <span className="mlx-pill" style={{ color: 'var(--warn)' }}>unverified</span>}</div>
        <div className="mlx-s" style={{ marginTop: 4 }}>{presetInfo.notes}</div>
        {presetInfo.docs ? <a className="mlx-s" href={presetInfo.docs} target="_blank" rel="noreferrer noopener">Provider documentation</a> : null}
      </div> : null}
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
        {t === 'google' ? <Field label="Sign-in method">
          <select className="mlx-in" value={a.auth.method === 'oauth2' ? 'oauth2' : 'app-password'} onChange={e => set('auth.method', e.target.value)}>
            <option value="app-password">App password (simplest)</option><option value="oauth2">OAuth2 with your own Google client (Workspace)</option>
          </select>
        </Field> : null}
        {oauth ? <OAuthPanel a={a} set={set} isNew={!saved} initial={initial} saveFirst={saveFirst} /> : <div className="mlx-grid">
          <Field label="Login" hint="Empty: the email address"><input className="mlx-in mlx-mono" value={(a.auth && a.auth.user) || ''} onChange={e => set('auth.user', e.target.value.trim())} /></Field>
          <Field label={t === 'google' ? 'App password' : 'Password'}><SecretInput value={a.secrets.password} onChange={v => set('secrets.password', v)} /></Field>
        </div>}
        <details style={{ marginBottom: 8 }}>
          <summary className="mlx-s" style={{ cursor: 'pointer' }}>Password from a file or an environment variable, certificates</summary>
          <div className="mlx-grid" style={{ marginTop: 6 }}>
            <Field label="Password file"><input className="mlx-in mlx-mono" value={a.passwordFile || ''} onChange={e => set('passwordFile', e.target.value.trim())} placeholder="/path/to/secret" /></Field>
            <Field label="Password env var"><input className="mlx-in mlx-mono" value={a.passwordEnv || ''} onChange={e => set('passwordEnv', e.target.value.trim())} placeholder="MAIL_PASSWORD" /></Field>
          </div>
          <Check checked={a.allowSelfSigned} onChange={v => set('allowSelfSigned', v)}>Accept a self-signed certificate (only for your own server or a local bridge)</Check>
        </details>
        {a.allowSelfSigned ? <div className="mlx-note warn" role="alert">Insecure: certificate verification is OFF for this account. The link is still encrypted, but anyone in the path could impersonate the server and read the password. Use it only for your own server or a local bridge such as Proton Mail Bridge.</div> : null}
      </> : null}
      {t === 'tzekos' ? <div className="mlx-grid">
        <Field label="Webmail base URL"><input className="mlx-in mlx-mono" value={(a.api && a.api.baseUrl) || ''} onChange={e => set('api.baseUrl', e.target.value.trim())} placeholder="https://mail.example.com" /></Field>
        <Field label="Service token"><SecretInput value={a.secrets.apiKey} onChange={v => set('secrets.apiKey', v)} /></Field>
      </div> : null}
      {t === 'sendgrid' ? <SendgridInbound a={a} set={set} saved={saved} /> : null}
      {['lettermint', 'resend', 'agentmail', 'sendgrid'].includes(t) ? <div className="mlx-grid">
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
      {mailProto && !oauth || t === 'imap-smtp' || t === 'local' || t === 'google' || t === 'microsoft' ? <div className="mlx-grid">
        <Field label="Unsubscribe mailbox" hint="Replies here are processed. Empty: your address with +unsubscribe"><input className="mlx-in mlx-mono" value={(a.unsubscribe && a.unsubscribe.mailto) || ''} onChange={e => set('unsubscribe.mailto', e.target.value.trim())} /></Field>
        {a.receive && a.receive.protocol === 'imap' ? <Field label="New mail"><Check checked={!!a.push} onChange={v => set('push', v)}>Instant (IMAP IDLE)</Check></Field> : null}
      </div> : null}
      <div className="mlx-flex">
        <Check checked={a.enabled} onChange={v => set('enabled', v)}>Enabled</Check>
        <Check checked={a.isDefaultSender} onChange={v => set('isDefaultSender', v)}>Default sender in the composer</Check>
      </div>
      <div className="mlx-grid">
        <Field label="Max recipients per message"><input className="mlx-in" type="number" value={(a.limits && a.limits.maxRecipients) || 500} onChange={e => set('limits.maxRecipients', Number(e.target.value))} /></Field>
        <Field label="Messages per minute" hint="0 = no limit"><input className="mlx-in" type="number" min="0" value={a.limits && a.limits.perMinute != null ? a.limits.perMinute : 20} onChange={e => set('limits.perMinute', Number(e.target.value))} /></Field>
        <Field label="Messages per day" hint="0 = no limit"><input className="mlx-in" type="number" min="0" value={a.limits && a.limits.perDay != null ? a.limits.perDay : 300} onChange={e => set('limits.perDay', Number(e.target.value))} /></Field>
      </div>
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

const ADD_ORDER = ['imap-smtp', 'pop3-smtp', 'google', 'microsoft', 'tzekos', 'lettermint', 'resend', 'sendgrid', 'agentmail', 'local']

function UnsubscribeSettings() {
  const [u, setU] = useState(null)
  const [st, setSt] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    apiGet('/accounts').then(r => setU(r.settings.unsubscribe || {})).catch(() => {})
    apiGet('/unsubscribe/status').then(setSt).catch(() => {})
  }, [])
  if (!u) return null
  const set = (k, v) => setU({ ...u, [k]: v })
  const save = async () => {
    setMsg('')
    try { await apiPost('/settings', { settings: { unsubscribe: { publicBaseUrl: u.publicBaseUrl || '', mailto: u.mailto || '', language: u.language || 'en', footer: u.footer !== false, listenPort: Number(u.listenPort) || 0, texts: u.texts || {} } } }); setMsg('Saved.') } catch (e) { setMsg(e.message) }
  }
  return (
    <div className="mlx-acc">
      <b>Unsubscribe</b>
      <div className="mlx-s" style={{ margin: '4px 0' }}>Every mass mail gets a personal unsubscribe link and address (List-Unsubscribe, one-click when a public address is set) and a footer. Unsubscribe replies to the addresses below are processed when mail is synced. The list of unsubscribed addresses is in the Mail tab (no-entry icon).</div>
      <div className="mlx-grid">
        <Field label="Public base URL for one-click links" hint="https://host; the edge must route /dsh-mail-unsub/* to the unsubscribe listener without login"><input className="mlx-in mlx-mono" value={u.publicBaseUrl || ''} onChange={e => set('publicBaseUrl', e.target.value.trim())} placeholder="https://mail-unsub.example.org" /></Field>
        <Field label="Unsubscribe mailbox" hint="Used when an account has none; must be read by one of the accounts"><input className="mlx-in mlx-mono" value={u.mailto || ''} onChange={e => set('mailto', e.target.value.trim())} placeholder="unsubscribe@example.org" /></Field>
        <Field label="Listener port" hint="0 = off; restart needed"><input className="mlx-in" type="number" value={u.listenPort || 0} onChange={e => set('listenPort', Number(e.target.value))} /></Field>
        <Field label="Footer language">
          <select className="mlx-in" value={u.language || 'en'} onChange={e => set('language', e.target.value)}><option value="en">English</option><option value="it">Italiano</option><option value="el">Ελληνικά</option></select>
        </Field>
      </div>
      <Check checked={u.footer !== false} onChange={v => set('footer', v)}>Add the unsubscribe footer to mass mails</Check>
      <details><summary className="mlx-s" style={{ cursor: 'pointer' }}>Custom footer texts ({'{sender}'} {'{url}'} {'{mailto}'})</summary>
        {['en', 'it', 'el'].map(l => <Field key={l} label={l}><textarea className="mlx-in" rows={2} value={(u.texts && u.texts[l]) || ''} onChange={e => set('texts', { ...(u.texts || {}), [l]: e.target.value })} /></Field>)}
      </details>
      {st ? <div className="mlx-s" style={{ marginTop: 4 }}>Processed mailboxes: {st.mailto.length ? st.mailto.join(', ') : 'none'}. Listener: {st.listener ? st.listener.host + ':' + st.listener.port : 'off'}.</div> : null}
      <div className="mlx-flex" style={{ marginTop: 6 }}><button type="button" className="mlx-btn" onClick={() => void save()}>Save</button>{msg ? <span className="mlx-s">{msg}</span> : null}</div>
    </div>
  )
}

export function SuppressionList() {
  const [list, setList] = useState(null)
  const [add, setAdd] = useState('')
  const [err, setErr] = useState('')
  const load = () => apiGet('/suppress').then(r => setList(r.addresses)).catch(e => setErr(e.message))
  useEffect(() => { void load() }, [])
  const post = async body => { setErr(''); try { const r = await apiPost('/suppress', body); setList(r.addresses); setAdd('') } catch (e) { setErr(e.message) } }
  return (
    <div className="mlx-acc">
      <b>Suppression list</b>
      <div className="mlx-s" style={{ margin: '4px 0' }}>Mass sends skip these addresses (or whole @domains). Hard bounces are added automatically.</div>
      <div className="mlx-flex"><input className="mlx-in" style={{ flex: 1 }} value={add} onChange={e => setAdd(e.target.value)} placeholder="name@example.com or @example.com" /><button type="button" className="mlx-btn" disabled={!add} onClick={() => void post({ add })}>Add</button></div>
      {err ? <div className="mlx-note bad">{err}</div> : null}
      <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }}>
        {(list || []).map(x => <div key={x} className="mlx-flex"><span className="mlx-mono" style={{ flex: 1 }}>{x}</span><button type="button" className="mlx-btn" onClick={() => void post({ remove: x })}>Remove</button></div>)}
        {list && !list.length ? <div className="mlx-s">Empty.</div> : null}
      </div>
    </div>
  )
}

export function AccountsEditor({ onChanged }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(null) // { account, isNew }
  const [note, setNote] = useState('')
  const [testing, setTesting] = useState({})
  const [glob, setGlob] = useState(null)
  const [presets, setPresets] = useState([])
  const [pick, setPick] = useState('type:imap-smtp')
  const [conv, setConv] = useState(null)
  useEffect(() => { apiGet('/presets').then(r => setPresets(r.presets)).catch(() => {}) }, [])
  async function convert() {
    if (!window.confirm('Convert the legacy provider settings into editable accounts?\n\nThe same account ids are kept, so old chats keep working. Today\'s agent behaviour is pinned (confirm mode, default account, first-contact check). A backup of your settings is written first. Secrets that sit in the settings move into the private secrets file; keys in credential files stay there.')) return
    setErr('')
    try { const r = await apiPost('/accounts/convert', { confirm: true }); setConv(r); await load(); if (onChanged) onChanged() } catch (e) { setErr(e.message) }
  }
  function startAdd() {
    if (pick.startsWith('preset:')) {
      const p = presets.find(x => x.id === pick.slice(7))
      if (!p) return
      if (p.unsupported) { setErr(p.unsupported); return }
      setEdit({ account: fromPreset(p), isNew: true })
    } else setEdit({ account: blank(pick.slice(5)), isNew: true })
    setNote('')
  }
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
      {conv ? <div className="mlx-note ok">Converted: {conv.converted.join(', ') || 'none'}{conv.skipped.length ? '. Kept as legacy: ' + conv.skipped.map(x => x.id + ' (' + x.reason + ')').join(', ') : ''}. Backups: {conv.backups.join(', ')}. Pinned: {Object.entries(conv.pins).map(([k, v]) => k + ' = ' + v).join(', ') || 'nothing'}.</div> : null}
      {edit ? <AccountForm initial={edit.account} isNew={edit.isNew} types={data.types} presets={presets} onDone={m => void done(m)} onCancel={() => setEdit(null)} /> : <>
        {all.length === 0 ? <div className="mlx-empty">Add your first account: any IMAP or POP3 mailbox, Gmail with an app password, or a sending service.</div> : null}
        {data.accounts.map(a => (
          <div key={a.id} className="mlx-acc">
            <div className="mlx-flex">
              <span className="mlx-dot" style={{ background: a.color }} />
              <b>{a.label}</b><span className="mlx-s mlx-mono">{a.id}</span>
              <span className="mlx-s">{a.type}{a.address ? ' · ' + a.address : ''}</span>
              <span style={{ flex: 1 }} />
              {!a.enabled ? <span className="mlx-pill">disabled</span> : null}
              {a.oauthStatus && a.oauthStatus.needsReauth ? <span className="mlx-pill" style={{ color: 'var(--warn)' }}>reconnect</span> : a.oauthStatus ? <span className="mlx-pill">{a.oauthStatus.connected ? 'connected' : 'not connected'}</span> : null}
              {a.agent.allow ? <span className="mlx-pill">agents</span> : null}
              <button type="button" className="mlx-btn" onClick={() => setEdit({ account: structuredClone(a), isNew: false })}>Edit</button>
            </div>
          </div>
        ))}
        {data.legacy.length ? <div className="mlx-note warn">
          <b>Legacy provider settings in use.</b> These accounts come from the v0.1 provider settings and the credential files, read only here. They keep working unchanged. Converting them makes them editable here; it only happens when you press the button.
          <div style={{ marginTop: 6 }}><button type="button" className="mlx-btn" onClick={() => void convert()}>Convert legacy settings to accounts</button></div>
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
          <select className="mlx-in" style={{ width: 'auto', maxWidth: '100%' }} value={pick} onChange={e => setPick(e.target.value)} aria-label="Provider or account type">
            <optgroup label="European providers">
              {presets.filter(p => p.region !== 'global').map(p => <option key={p.id} value={'preset:' + p.id} disabled={!!p.unsupported}>{p.label} ({p.region}){p.unsupported ? ', not supported' : p.verified ? '' : ', unverified'}</option>)}
            </optgroup>
            <optgroup label="Other providers">
              {presets.filter(p => p.region === 'global').map(p => <option key={p.id} value={'preset:' + p.id}>{p.label}{p.verified ? '' : ', unverified'}</option>)}
            </optgroup>
            <optgroup label="Account types">
              {ADD_ORDER.map(id => { const t = data.types.find(x => x.id === id); return t ? <option key={id} value={'type:' + id}>{t.label}</option> : null })}
            </optgroup>
          </select>
          <button type="button" className="mlx-btn p" onClick={startAdd}>Add account</button>
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
        <UnsubscribeSettings />
      </>}
    </div>
  )
}
