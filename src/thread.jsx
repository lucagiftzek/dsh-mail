/**
 * dsh-mail browser half: the reading view. Bodies arrive sanitised from the
 * host as a CSP document and are shown in an iframe sandbox WITHOUT
 * allow-scripts (allow-same-origin only lets the tab measure the height;
 * nothing inside can run).
 *
 * The browser never contacts a host named in a mail: remote images load only
 * through the server's signed image proxy (the message says proxy: true), and
 * links open the server's link page. A server without the proxy (an older
 * plugin version still running until the next DSH restart) gets no
 * "Load images" button at all, so nothing can fall back to a direct load.
 */
import { useEffect, useRef, useState } from 'react'
import { apiGet, attachmentUrl } from './api.js'
import { fullTime, relTime, who, fmtSize } from './util.js'
import { Avatar } from './list.jsx'
import { I } from './icons.jsx'

function Frame({ srcdoc }) {
  const ref = useRef(null)
  const [h, setH] = useState(120)
  const fit = () => {
    try { const d = ref.current && ref.current.contentDocument; if (d && d.documentElement) setH(Math.min(20000, Math.max(60, d.documentElement.scrollHeight + 4))) } catch {}
  }
  return <iframe ref={ref} className="mlx-frame" title="Message body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={srcdoc} style={{ height: h }} onLoad={() => { fit(); setTimeout(fit, 300) }} />
}

function toLine(m) {
  const list = [...(m.to || []), ...(m.cc || [])]
  if (!list.length) return ''
  const first = who(list[0])
  return 'to ' + first + (list.length > 1 ? ', ' + (list.length - 1) + ' other' + (list.length > 2 ? 's' : '') : '')
}

function MessageCard({ m, expanded, onToggle, onReply }) {
  const [full, setFull] = useState(m.srcdoc ? m : null)
  const [err, setErr] = useState('')
  const [images, setImages] = useState(false)
  const [showTo, setShowTo] = useState(false)
  useEffect(() => {
    if (!expanded || m.srcdoc) return
    let alive = true
    setErr('')
    apiGet('/message', { id: m.id, images: images ? '1' : '' }).then(r => { if (alive) setFull(r.message) }).catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [expanded, m.id, images])
  const msg = full || m
  return (
    <div className="mlx-card">
      <button type="button" className="mlx-ch" onClick={onToggle} aria-expanded={expanded}>
        <Avatar name={msg.from && msg.from.name} address={msg.from && msg.from.address} size={32} />
        <span className="w">
          <div><b style={{ fontWeight: m.seen ? 600 : 700 }}>{who(msg.from) || '(unknown)'}</b> {expanded && msg.from && msg.from.name ? <span className="mlx-s">{msg.from.address}</span> : null}</div>
          <div className="mlx-s">{expanded ? toLine(msg) : (m.snippet || '')}</div>
        </span>
        <span className="mlx-time" title={fullTime(msg.date)}>{relTime(msg.date)}</span>
      </button>
      {expanded ? <>
        <div className="mlx-flex" style={{ padding: '0 10px 6px' }}>
          <button type="button" className="mlx-btn" onClick={() => setShowTo(!showTo)}>{showTo ? 'Hide details' : 'Details'}</button>
          <span style={{ flex: 1 }} />
          {onReply ? <button type="button" className="mlx-ib" aria-label="Reply" title="Reply" onClick={() => onReply(msg, 'reply')}>{I.reply(15)}</button> : null}
          {onReply ? <button type="button" className="mlx-ib" aria-label="Forward" title="Forward" onClick={() => onReply(msg, 'forward')}>{I.fwd(15)}</button> : null}
        </div>
        {showTo ? <div className="mlx-s" style={{ padding: '0 10px 8px', lineHeight: 1.6 }}>
          <div>From: {msg.from ? (msg.from.name ? msg.from.name + ' <' + msg.from.address + '>' : msg.from.address) : ''}</div>
          {(msg.to || []).length ? <div>To: {msg.to.map(a => a.address || a.name).join(', ')}</div> : null}
          {(msg.cc || []).length ? <div>Cc: {msg.cc.map(a => a.address || a.name).join(', ')}</div> : null}
          <div>Date: {fullTime(msg.date)}</div>
        </div> : null}
        {err ? <div className="mlx-note bad">{err}</div> : null}
        {!full && !err ? <div className="mlx-skel" /> : null}
        {full ? <Frame srcdoc={full.srcdoc} /> : null}
        {full && full.blocked > 0 && !images ? <div className="mlx-imgbar">
          <span>{full.blocked} remote image{full.blocked > 1 ? 's' : ''} blocked for privacy.{full.proxy === true ? '' : ' Loading them through the server needs the updated Mail server (next DSH restart).'}</span>
          {full.proxy === true ? <button type="button" className="mlx-btn" title="The DSH server fetches the images; your browser never contacts the sender's servers" onClick={() => setImages(true)}>Load images</button> : null}
        </div> : null}
        {full && images && full.imagesLoaded ? <div className="mlx-imgbar"><span>Images loaded through the server: the senders saw the DSH server, not your device.</span></div> : null}
        {full && (full.attachments || []).length ? <div className="mlx-atts">
          {full.attachments.map(a => (
            <a key={a.part} className="mlx-att" href={attachmentUrl(full.id, a.part)} download={a.filename} rel="noreferrer" title={'Download ' + a.filename}>
              {I.clip(12)}<span className="f">{a.filename}</span><span className="mlx-s">{fmtSize(a.size)}</span>
            </a>
          ))}
        </div> : null}
      </> : null}
    </div>
  )
}

export function ThreadView({ open, onAct, onReply, onBack }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState(new Set())
  useEffect(() => {
    let alive = true
    setData(null); setErr('')
    apiGet('/thread', { account: open.account, thread: open.thread, folder: open.folder }).then(r => {
      if (!alive) return
      setData(r)
      const msgs = r.messages || []
      const ex = new Set(msgs.filter(m => !m.seen).map(m => m.id))
      if (msgs.length) ex.add(msgs[msgs.length - 1].id)
      setExpanded(ex)
    }).catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [open.account, open.thread])
  const msgs = (data && data.messages) || []
  const last = msgs[msgs.length - 1]
  const subject = (data && data.subject) || open.subject || '(no subject)'
  const flagged = msgs.some(m => m.flagged)
  return (
    <div className="mlx-body">
      <div className="mlx-tb" role="toolbar" aria-label="Conversation actions">
        <button type="button" className="mlx-ib" aria-label="Back" onClick={onBack}>{I.back(16)}</button>
        <span className="mlx-s" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</span>
        <button type="button" className="mlx-ib" aria-label="Archive" title="Archive (e)" onClick={() => onAct('archive')}>{I.archive(15)}</button>
        <button type="button" className="mlx-ib" aria-label="Delete" title="Delete (#)" onClick={() => onAct('trash')}>{I.trash(15)}</button>
        <button type="button" className="mlx-ib" aria-label={flagged ? 'Unflag' : 'Flag'} aria-pressed={flagged} title="Flag" onClick={() => onAct(flagged ? 'unflag' : 'flag')}>{I.flag(15)}</button>
        <button type="button" className="mlx-ib" aria-label="Mark unread" title="Mark unread" onClick={() => onAct('unread')}>{I.mail(15)}</button>
      </div>
      <div className="mlx-tsub">{subject}</div>
      {err ? <div className="mlx-note bad">{err}</div> : null}
      {!data && !err ? <div><div className="mlx-skel" /><div className="mlx-skel" /></div> : null}
      {data && data.reminder ? <div className="mlx-note warn">Reminder: {fullTime(Date.parse(data.reminder.remind_at))}{data.reminder.note ? ', ' + data.reminder.note : ''}</div> : null}
      {msgs.map(m => (
        <MessageCard key={m.id} m={m} expanded={expanded.has(m.id)} onReply={onReply}
          onToggle={() => { const s = new Set(expanded); if (s.has(m.id)) s.delete(m.id); else s.add(m.id); setExpanded(s) }} />
      ))}
      {last ? <div style={{ padding: '4px 10px 24px' }}>
        <button type="button" className="mlx-in" style={{ textAlign: 'left', cursor: 'text', color: 'var(--ink3)' }} onClick={() => onReply(last, 'reply')}>Reply</button>
      </div> : null}
    </div>
  )
}
