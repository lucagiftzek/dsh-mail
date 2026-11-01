/** dsh-mail browser half: small formatting helpers. */

export function initials(name, address) {
  const s = String(name || address || '?').replace(/<.*>/, '').trim()
  const parts = s.split(/[\s._@-]+/).filter(Boolean)
  const t = parts.length >= 2 ? parts[0][0] + parts[1][0] : s.slice(0, 2)
  return t.toUpperCase()
}

const PALETTE = ['#4d6bfe', '#2e9e5b', '#c98a14', '#cf3b3b', '#8b5cf6', '#0e9aa7', '#d9480f', '#5c7cfa', '#b8327a', '#3d8b40']
export function colorFor(s) {
  let h = 0
  for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function relTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = (now - d) / 86400000
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' })
}

export function fullTime(ms) { return ms ? new Date(ms).toLocaleString() : '' }

export function fmtSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return b + ' B'
  if (b < 1048576) return Math.round(b / 1024) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

export function who(a) { return a ? (a.name || a.address || '') : '' }

export function loadSel() {
  try { const v = JSON.parse(localStorage.getItem('dsh-mail:sel') || 'null'); if (v && typeof v === 'object') return v } catch {}
  return { account: 'all', folder: '' }
}
export function saveSel(v) { try { localStorage.setItem('dsh-mail:sel', JSON.stringify(v)) } catch {} }
