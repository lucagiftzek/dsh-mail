/** dsh-mail browser half: the thread list (rows, quick actions, select mode). */
import { useState } from 'react'
import { initials, colorFor, relTime, who } from './util.js'
import { I } from './icons.jsx'

export function Avatar({ name, address, size = 36 }) {
  return <span className="mlx-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: colorFor(address || name) }} aria-hidden="true">{initials(name, address)}</span>
}

function Row({ t, unified, active, selecting, checked, onToggle, onOpen, onAct }) {
  const [open, setOpen] = useState(false)
  const unread = t.unread > 0
  const label = (unread ? 'Unread, ' : '') + 'From ' + (who(t.from) || 'unknown') + ', ' + (t.subject || 'no subject') + ', ' + relTime(t.date)
  return (
    <li className="mlx-li">
      <div style={{ display: 'flex' }}>
        {selecting ? <input type="checkbox" className="mlx-sel" checked={checked} onChange={onToggle} aria-label={'Select ' + (t.subject || 'conversation')} /> : null}
        <button type="button" className={'mlx-row' + (active ? ' on' : '')} aria-label={label} onClick={() => (selecting ? onToggle() : onOpen())}>
          <span className={'mlx-ud' + (unread ? ' u' : '')} />
          <Avatar name={t.from && t.from.name} address={t.from && t.from.address} />
          <span className="mlx-col">
            <span className="mlx-l1"><span className={'s' + (unread ? ' u' : '')}>{who(t.from) || '(unknown sender)'}</span><span className="mlx-time">{relTime(t.date)}</span></span>
            <span className="mlx-sub">{t.subject || '(no subject)'}</span>
            {t.snippet ? <span className="mlx-snip">{t.snippet}</span> : null}
            {(t.flagged || t.hasAtt || t.count > 1 || unified) ? <span className="mlx-bdg">
              {t.flagged ? <span style={{ color: 'var(--warn)' }} title="Flagged">{I.flag(12)}</span> : null}
              {t.hasAtt ? <span title="Attachment">{I.clip(12)}</span> : null}
              {t.count > 1 ? <span className="mlx-cnt">{t.count}</span> : null}
              {unified ? <span className="mlx-sq" style={{ background: t.color || 'var(--ink3)' }} title={t.account} /> : null}
            </span> : null}
          </span>
        </button>
      </div>
      {!selecting ? <>
        <div className={'mlx-acts' + (open ? ' open' : '')} role="group" aria-label="Quick actions">
          <button type="button" className="mlx-ib" aria-label="Archive" title="Archive" onClick={() => onAct('archive')}>{I.archive(15)}</button>
          <button type="button" className="mlx-ib" aria-label="Delete" title="Delete" onClick={() => onAct('trash')}>{I.trash(15)}</button>
          <button type="button" className="mlx-ib" aria-label={unread ? 'Mark read' : 'Mark unread'} title={unread ? 'Mark read' : 'Mark unread'} onClick={() => onAct(unread ? 'read' : 'unread')}>{I.mail(15)}</button>
          <button type="button" className="mlx-ib" aria-label={t.flagged ? 'Unflag' : 'Flag'} title={t.flagged ? 'Unflag' : 'Flag'} onClick={() => onAct(t.flagged ? 'unflag' : 'flag')}>{I.flag(15)}</button>
        </div>
        <button type="button" className="mlx-ib mlx-more" aria-label="More actions" onClick={() => setOpen(!open)}>{I.dots(15)}</button>
      </> : null}
    </li>
  )
}

export function ThreadList({ rows, loading, unified, activeKey, selecting, selected, setSelected, onOpen, onAct, empty }) {
  if (loading && !rows.length) return <div aria-busy="true">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="mlx-skel" />)}</div>
  if (!rows.length) return <div className="mlx-empty">{empty}</div>
  return (
    <ul className="mlx-list" role="list">
      {rows.map(t => {
        const k = t.account + '|' + t.thread
        return <Row key={k} t={t} unified={unified} active={activeKey === k} selecting={selecting} checked={selected.has(k)}
          onToggle={() => { const s = new Set(selected); if (s.has(k)) s.delete(k); else s.add(k); setSelected(s) }}
          onOpen={() => onOpen(t)} onAct={a => onAct([t], a)} />
      })}
    </ul>
  )
}
