/** dsh-mail tests: a tiny shared harness (no test framework dependency). */
export const stats = { passed: 0, failed: 0, failures: [] }

export async function test(name, fn) {
  try { await fn(); stats.passed++; console.log('  ok   ' + name) }
  catch (e) { stats.failed++; stats.failures.push(name); console.error('  FAIL ' + name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)) }
}

export function section(title) { console.log('\n' + title) }
