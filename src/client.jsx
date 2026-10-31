/**
 * dsh-mail: browser half (entry).
 *
 * Registers the Mail sidebar tab on dsh-better-sidebar and a "Mail" section in
 * DSH Settings (settings.section slot) that hosts the accounts editor.
 * The client is never the authority; the host recomputes and re-checks
 * everything. Purity: no @deepseek-ai/* value imports.
 */
import { useEffect } from 'react'
import { MailView, shared } from './app.jsx'
import { AccountsEditor } from './accounts.jsx'
import { injectCss } from './css.js'
import { I } from './icons.jsx'

const TAB_ID = 'dsh-mail:main'

function Tab({ visible }) {
  useEffect(() => { injectCss() }, [])
  return <MailView visible={visible} />
}

function SettingsSection() {
  useEffect(() => { injectCss() }, [])
  return (
    <div className="mlx" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="mlx-s" style={{ marginBottom: 8 }}>Mail accounts for the Mail tab and the mail_* agent tools. Secrets are stored in your settings and never shown again; type to replace one.</div>
      <AccountsEditor />
    </div>
  )
}

export const inject = ['betterSidebar', 'slots']

export function apply(ctx) {
  injectCss()
  if (ctx.betterSidebar && typeof ctx.betterSidebar.registerTab === 'function') {
    ctx.effect(() => ctx.betterSidebar.registerTab({
      id: TAB_ID,
      title: 'Mail',
      order: 91,
      single: true,
      icon: size => I.mail(size),
      badge: () => (shared.badge > 0 ? shared.badge : null),
      component: props => <Tab visible={props.visible !== false} />,
    }), 'dsh-mail: register the Mail sidebar tab')
  } else {
    console.error('[dsh-mail] ctx.betterSidebar.registerTab is unavailable; Mail tab not registered')
  }
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.effect(() => {
      const d = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-mail',
        order: 61,
        label: () => 'Mail',
        inject: () => ({}),
      }, function MailSettingsSlot() { return <SettingsSection /> }))
      return typeof d === 'function' ? d : () => {}
    }, 'dsh-mail: settings section')
  }
}
