/**
 * Move the phone drawer aside when navigation selects a main panel or Session.
 *
 * The panel the drawer navigates to is drawn in the centre column, but on the phone
 * form the sidebar is a `position: fixed` off-canvas overlay 289px wide (mobile-form.css.ts).
 * Selecting a panel therefore left the drawer covering the panel it had just opened -
 * including that panel's own back control, which the user then could not see or tap
 * ("点进去就出不来" / "你关闭键呢").
 *
 * Upstream cannot do this itself: `selectPanel` only writes `panelInfo.activePanelId`,
 * and the docked desktop sidebar has no reason to close. Closing only on the
 * Conversation -> panel or main-Session transition (rather than on every
 * notification) keeps a user who re-opens the drawer in control. New Session
 * does not change activePanelId, so its main-view ownership needs a separate
 * subscription (APK #349).
 */
/** Phone-form marker (mobile/form-marker.ts); the drawer is an overlay only on phones. */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** Frame root tag written by the form marker. */
const FRAME_SELECTOR = '[data-dsh-frame]'
/** Frame attribute: present while the left drawer is collapsed. */
const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

/** The frame facts this behaviour reads. */
export interface PanelNavDrawerDeps {
  /** The presented main panel, or null while the Conversation is shown. */
  activePanelId(): string | null
  /** Main-view owner from the Session Controller; undefined during an ambiguous hand-off. */
  currentSessionId(): string | null | undefined
  /** Collapse the drawer: upstream `ctx.layout.toggleSidebar()`. */
  collapseDrawer(): void
  /** The tagged frame root, or null before the form marker lands. */
  frame(): Element | null
}

/**
 * Collapses the drawer once when the presented panel or main Session changes.
 *
 * Not a subscription owner: the caller feeds it layout and Session notifications,
 * so this class holds no listener of its own and cannot leak one.
 */
export class PanelNavDrawer {
  private readonly deps: PanelNavDrawerDeps
  private lastPanelId: string | null
  private lastSessionId: string | null | undefined

  /** @param deps - frame facts and the drawer action. */
  constructor(deps: PanelNavDrawerDeps) {
    this.deps = deps
    this.lastPanelId = deps.activePanelId()
    this.lastSessionId = deps.currentSessionId()
  }

  /**
   * Reconcile against the current panel and main-Session selection.
   * @returns whether the drawer was collapsed by this call.
   */
  sync(): boolean {
    const panelId = this.deps.activePanelId()
    const opened = panelId !== null && this.lastPanelId === null
    this.lastPanelId = panelId
    const sessionId = this.deps.currentSessionId()
    const switchedSession = sessionId !== undefined && sessionId !== null
      && sessionId !== this.lastSessionId
    if (sessionId !== undefined) this.lastSessionId = sessionId
    if (!opened && !switchedSession) return false
    if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return false
    const frame = this.deps.frame() ?? document.querySelector(FRAME_SELECTOR)
    // Already collapsed: nothing to do, and calling the toggle would re-open it.
    if (frame === null || frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR)) return false
    this.deps.collapseDrawer()
    return true
  }
}

/**
 * Read the same main-view ownership fact used by upstream's frame/title.
 * A navigation retains the next Session before releasing the previous one;
 * do not choose a row by object order while both temporarily own mainView.
 */
export function mainViewSessionId(snapshot: {
  byId: Readonly<Record<string, { id: string; retainedBy: Readonly<Partial<Record<'mainView', number>>> }>>
}): string | null | undefined {
  const selected = Object.values(snapshot.byId).filter(row => (row.retainedBy.mainView ?? 0) > 0)
  if (selected.length > 1) return undefined
  return selected[0]?.id ?? null
}

/** Observe a completed retain/release hand-off and cancel queued work on disposal. */
export function watchSessionNavigation(
  drawer: PanelNavDrawer,
  source: { subscribe(listener: () => void): () => void },
  refreshBackStack: () => void,
): () => void {
  let disposed = false
  let queued = false
  const unsubscribe = source.subscribe(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (disposed) return
      drawer.sync()
      refreshBackStack()
    })
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
