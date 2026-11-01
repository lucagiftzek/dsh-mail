/** dsh-mail browser half: inline stroke icons (no icon font, no network). */
const S = (size, children) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
export const I = {
  mail: s => S(s, <><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.5" /><path d="M2 4l6 4.5L14 4" /></>),
  back: s => S(s, <path d="M10 3L5 8l5 5" />),
  gear: s => S(s, <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>),
  refresh: s => S(s, <><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></>),
  archive: s => S(s, <><rect x="2" y="3" width="12" height="3" rx=".8" /><path d="M3 6v7h10V6M6.5 9h3" /></>),
  trash: s => S(s, <><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" /></>),
  flag: s => S(s, <><path d="M3.5 14V2.5M3.5 3h8l-1.6 3 1.6 3h-8" /></>),
  clip: s => S(s, <path d="M10.5 4.5L5.6 9.4a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4.2-4.2" />),
  dots: s => S(s, <><circle cx="3.5" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="12.5" cy="8" r=".8" /></>),
  pen: s => S(s, <><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" /></>),
  check: s => S(s, <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8l2 2 3-4" /></>),
  queue: s => S(s, <><path d="M3 4h10M3 8h10M3 12h6" /></>),
  folder: s => S(s, <path d="M2 4.5V12.5h12V5.5H8L6.5 4H2z" />),
  reply: s => S(s, <><path d="M6.5 4L2.5 8l4 4" /><path d="M2.5 8H10a3.5 3.5 0 0 1 3.5 3.5V13" /></>),
  fwd: s => S(s, <><path d="M9.5 4l4 4-4 4" /><path d="M13.5 8H6a3.5 3.5 0 0 0-3.5 3.5V13" /></>),
  menu: s => S(s, <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />),
  search: s => S(s, <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></>),
  block: s => S(s, <><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></>),
}
