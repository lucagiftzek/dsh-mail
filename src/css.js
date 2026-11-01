/** dsh-mail browser half: one stylesheet, DSH design tokens only (colours below are fallbacks). */
export const CSS = `
.mlx{--ok:var(--dsw-alias-state-success-primary,#2e9e5b);--warn:var(--dsw-alias-state-warn-primary,#c98a14);--bad:var(--dsw-alias-state-error-primary,#cf3b3b);--brand:var(--dsw-alias-brand-primary,#4d6bfe);--on-brand:var(--dsw-alias-label-primary-foreground,#fff);--ink:var(--dsw-alias-label-primary,inherit);--ink2:var(--dsw-alias-label-secondary,inherit);--ink3:var(--dsw-alias-label-tertiary,inherit);--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));--line1:var(--dsw-alias-border-l1,rgba(128,128,128,.18));--l1:var(--dsw-alias-bg-layer-1,transparent);--l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));--hov:var(--dsh-alias-interactive-bg-hover,rgba(128,128,128,.12));--bg:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));
display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font:inherit;font-size:13px;color:var(--ink);position:relative;outline:none}
.mlx *{box-sizing:border-box}
.mlx button{font:inherit;color:inherit}
.mlx :focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
.mlx-hd{display:flex;align-items:center;gap:6px;height:44px;padding:0 8px;border-bottom:1px solid var(--line);flex:0 0 auto;min-width:0}
.mlx-hd .t{font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-ib{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;cursor:pointer;flex:0 0 auto;position:relative;color:var(--ink2)}
.mlx-ib:hover{background:var(--hov);color:var(--ink)}
.mlx-ib[aria-pressed=true]{background:var(--l2);color:var(--brand)}
.mlx-badge{position:absolute;top:1px;right:0;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--brand);color:var(--on-brand);font-size:9.5px;font-weight:700;line-height:15px;text-align:center}
.mlx-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:2px 8px 2px 2px;background:transparent;cursor:pointer;max-width:55%;min-width:0}
.mlx-chip:hover{background:var(--hov)}
.mlx-chip .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.mlx-av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:700;flex:0 0 auto;letter-spacing:.02em}
.mlx-av.b{color:var(--on-brand)}
.mlx-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.mlx-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
.mlx-pad{padding:10px}
.mlx-strip{font-size:11.5px;padding:5px 10px;border-bottom:1px solid var(--line1);display:flex;gap:6px;align-items:center;background:var(--l2)}
.mlx-strip.bad{color:var(--bad)}.mlx-strip.warn{color:var(--warn)}
.mlx-strip button{border:0;background:transparent;text-decoration:underline;cursor:pointer;padding:0;color:inherit}
.mlx-ftitle{display:flex;align-items:center;gap:8px;padding:10px 12px 4px}
.mlx-ftitle h2{font-size:20px;font-weight:700;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-pill{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--l2);border:1px solid var(--line1);font-weight:600;white-space:nowrap;color:var(--ink2)}
.mlx-pill.b{background:var(--brand);color:var(--on-brand);border-color:transparent}
.mlx-search{padding:4px 12px 4px;display:flex;gap:6px;align-items:center}
.mlx-in{font:inherit;font-size:13px;width:100%;padding:6px 9px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;min-width:0}
.mlx-in:focus{outline:2px solid var(--brand);outline-offset:-1px}
textarea.mlx-in{resize:vertical;line-height:1.45}
.mlx-chips{display:flex;gap:6px;padding:4px 12px 8px;overflow-x:auto;scrollbar-width:none}
.mlx-chips::-webkit-scrollbar{display:none}
.mlx-fchip{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:transparent;cursor:pointer;white-space:nowrap;color:var(--ink2)}
.mlx-fchip[aria-pressed=true]{background:var(--l2);color:var(--ink);border-color:var(--brand);font-weight:600}
.mlx-list{list-style:none;margin:0;padding:0}
.mlx-li{position:relative;border-bottom:1px solid var(--line1)}
.mlx-row{display:flex;gap:8px;align-items:flex-start;width:100%;min-height:64px;padding:9px 10px 9px 4px;border:0;background:transparent;text-align:left;cursor:pointer}
.mlx-row:hover,.mlx-row.on{background:var(--hov)}
.mlx-ud{width:8px;height:8px;border-radius:50%;margin-top:14px;flex:0 0 8px;background:transparent}
.mlx-ud.u{background:var(--brand)}
.mlx-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.mlx-l1{display:flex;align-items:baseline;gap:6px;min-width:0}
.mlx-l1 .s{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-l1 .s.u{font-weight:650}
.mlx-time{font-size:11px;color:var(--ink3);white-space:nowrap}
.mlx-sub{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-snip{font-size:13px;color:var(--ink3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35}
.mlx-bdg{display:flex;gap:5px;align-items:center;margin-top:3px;color:var(--ink3);font-size:11px}
.mlx-cnt{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:10.5px}
.mlx-sq{width:8px;height:8px;border-radius:2px;display:inline-block}
.mlx-acts{position:absolute;right:6px;top:6px;display:none;gap:2px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:2px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.mlx-li:hover .mlx-acts,.mlx-li:focus-within .mlx-acts,.mlx-acts.open{display:flex}
.mlx-more{position:absolute;right:4px;bottom:4px;display:none}
@media (hover:none){.mlx-more{display:inline-flex}.mlx-li:hover .mlx-acts{display:none}.mlx-acts.open{display:flex}}
.mlx-sel{margin:24px 0 0 6px;flex:0 0 auto}
.mlx-skel{height:64px;border-bottom:1px solid var(--line1);background:linear-gradient(90deg,var(--l2),var(--hov),var(--l2));background-size:200% 100%;animation:mlxs 1.2s infinite}
@keyframes mlxs{0%{background-position:200% 0}100%{background-position:-200% 0}}
.mlx-empty{color:var(--ink3);padding:24px 16px;text-align:center;line-height:1.5}
.mlx-fab{position:absolute;right:14px;bottom:14px;width:48px;height:48px;border-radius:50%;border:0;background:var(--dsw-alias-button-primary-fill,var(--brand));color:var(--on-brand);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.25);z-index:3}
.mlx-bulk{display:flex;gap:4px;padding:6px 8px;border-top:1px solid var(--line);flex:0 0 auto;align-items:center;flex-wrap:wrap}
.mlx-btn{font-size:12px;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:transparent;cursor:pointer;white-space:nowrap}
.mlx-btn:hover:not(:disabled){background:var(--hov)}
.mlx-btn:disabled{opacity:.45;cursor:not-allowed}
.mlx-btn.p{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--brand));color:var(--on-brand);font-weight:600}
.mlx-btn.d{border-color:var(--bad);color:var(--bad)}
.mlx-sheet{position:absolute;left:0;right:0;top:44px;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.18);max-height:70%;overflow:auto}
.mlx-sheet button.it{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;background:transparent;cursor:pointer;text-align:left}
.mlx-sheet button.it:hover,.mlx-sheet button.it[aria-current=true]{background:var(--hov)}
.mlx-sheet .meta{flex:1;min-width:0}
.mlx-sheet .meta div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-s{font-size:11.5px;color:var(--ink3)}
.mlx-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin:14px 12px 6px}
.mlx-fold{display:flex;align-items:center;gap:10px;width:100%;padding:8px 14px;border:0;background:transparent;cursor:pointer;text-align:left}
.mlx-fold:hover,.mlx-fold[aria-current=true]{background:var(--hov)}
.mlx-fold .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-tb{display:flex;align-items:center;gap:2px;height:40px;padding:0 6px;border-bottom:1px solid var(--line1);position:sticky;top:0;background:var(--bg);z-index:2}
.mlx-tsub{font-size:17px;font-weight:700;margin:12px 12px 6px;line-height:1.3;overflow-wrap:anywhere}
.mlx-card{border:1px solid var(--line);border-radius:10px;margin:8px 10px;background:var(--l1);overflow:hidden}
.mlx-ch{display:flex;gap:9px;align-items:flex-start;padding:10px;cursor:pointer;border:0;background:transparent;width:100%;text-align:left}
.mlx-ch .w{flex:1;min-width:0}
.mlx-ch .w div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlx-frame{width:100%;border:0;display:block;min-height:80px;background:transparent}
.mlx-imgbar{display:flex;gap:8px;align-items:center;padding:6px 10px;background:var(--l2);font-size:12px;border-top:1px solid var(--line1)}
.mlx-atts{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-top:1px solid var(--line1)}
.mlx-att{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px;text-decoration:none;color:inherit;max-width:100%}
.mlx-att span.f{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.mlx-att:hover{background:var(--hov)}
.mlx-note{border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:8px 10px;margin:8px 10px;line-height:1.5;background:var(--l1)}
.mlx-note.bad{border-left-color:var(--bad)}.mlx-note.warn{border-left-color:var(--warn)}.mlx-note.ok{border-left-color:var(--ok)}
.mlx-field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px;font-size:12px;color:var(--ink2);min-width:0}
.mlx-field em{font-style:normal;font-size:11px;color:var(--ink3)}
.mlx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0 8px}
.mlx-chk{display:flex;gap:6px;align-items:center;font-size:12px;margin:4px 0;cursor:pointer}
.mlx-acc{border:1px solid var(--line);border-radius:10px;padding:9px 10px;margin:0 0 8px;background:var(--l1)}
.mlx-flex{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.mlx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.mlx-qrow{border:1px solid var(--line1);border-radius:8px;padding:8px 10px;margin:0 10px 8px;background:var(--l1)}
.mlx-compose{position:absolute;left:0;right:0;bottom:0;height:92%;z-index:6;background:var(--bg);border-top:1px solid var(--line);border-radius:12px 12px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,.2);display:flex;flex-direction:column}
.mlx-handle{width:36px;height:4px;border-radius:2px;background:var(--line);margin:6px auto 0}
.mlx-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:72px;background:var(--ink,#222);color:var(--bg,#fff);padding:7px 14px;border-radius:8px;font-size:12px;z-index:8;max-width:90%}
.mlx-sec{padding:0}
.mlx-sec .mlx-acc{margin-left:0;margin-right:0}
`

export function injectCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById('dsh-mail-css')
  if (!el) { el = document.createElement('style'); el.id = 'dsh-mail-css'; document.head.appendChild(el) }
  if (el.textContent !== CSS) el.textContent = CSS
}
