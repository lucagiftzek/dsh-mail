/**
 * A strict output-schema check, the same rules DSH applies to a tool result: the value must be an object,
 * every key must be declared (additionalProperties: false), required keys must be present and every
 * declared key must have the declared type (boolean, string, integer, number, json).
 * Returns a list of problems (empty when the result is valid).
 */
export function schemaProblems(schema, value, label = 'value') {
  const out = []
  if (!schema || schema.type !== 'object') return out
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [label + ' is not an object']
  const props = schema.properties || {}
  for (const k of Object.keys(value)) {
    if (!(k in props)) { if (schema.additionalProperties === false) out.push(label + '.' + k + ' is not a declared property (additionalProperties: false)'); continue }
    const t = props[k].type
    const v = value[k]
    const ok = t === 'boolean' ? typeof v === 'boolean'
      : t === 'string' ? typeof v === 'string'
      : t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number'
      : true // json and anything else
    if (!ok) out.push(label + '.' + k + ' should be ' + t + ', got ' + (v === null ? 'null' : typeof v))
  }
  for (const [k, p] of Object.entries(props)) if (p.required === true && !(k in value)) out.push(label + '.' + k + ' is required but missing')
  return out
}
