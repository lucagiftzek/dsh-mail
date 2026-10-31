/**
 * dsh-mail browser half: API helpers. Reads are plain same-origin GETs;
 * mutations carry the short-lived capability token from GET /session.
 */
export const API = '/dsh-mail/api'

let token = null

async function mint() {
  const r = await fetch(API + '/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error('could not mint token (HTTP ' + r.status + ')')
  token = (await r.json()).token
  return token
}

export async function apiGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : ''
  const r = await fetch(API + path + qs, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  let j = null
  try { j = await r.json() } catch { j = null }
  if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status)
  return j
}

export async function apiPost(path, body) {
  const send = tok => fetch(API + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-mail-token': tok },
    body: JSON.stringify(body || {}),
  })
  let r = await send(token || await mint())
  if (r.status === 403) r = await send(await mint())
  let j = null
  try { j = await r.json() } catch { j = null }
  if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status)
  return j
}

export function attachmentUrl(id, part) {
  return API + '/attachment?' + new URLSearchParams({ id, part: String(part) }).toString()
}
