/**
 * Client half of the IDEA bridge bundle.
 *
 * It occupies one `conversation.input.dock` cell (a `list` slot declared by
 * `@deepseek-ai/dsh-client-ui-conversation`, contract §5) and, while the page
 * is visible, polls `GET /idea-bridge/pending` for message files the IDEA
 * plugin wrote, **claims** them with `POST /idea-bridge/claim` so only one of
 * possibly several UI instances (two tabs, two windows) may deliver each
 * message, writes `text` into this session's composer draft with the slot
 * standard props' `inputActions.setDraft(text)`, submits when the message asks
 * for it, and then acknowledges the ids with `POST /idea-bridge/ack`.
 *
 * Evidence for every API used here, in the shipped runtime:
 *
 * - The dock slot's standard props include `inputActions: InputActions`,
 *   `sessionId: SessionId` and `useSessions: UseSessions`:
 *   `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:3338-3385` (the slot
 *   catalog row, `conversation.input.dock`). The `conversation.input.activity`
 *   row at `:3261-3288` lists the same three props, which is why the
 *   voice-input plugin can destructure `inputActions` from its own component.
 * - `setDraft` / `submit` are the provided action face of the session input
 *   shell: `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:14911-14938`
 *   (`actions = { captureInsertion, insertText, setDraft, persistDraft,
 *   addAttachments, removeAttachment, pruneAttachments, submit }`), provided to
 *   the session scope at `:19709-19725` (`ctx.uiSession.provide({ hooks: [...],
 *   props: ["inputActions"], ... })`).
 * - The session cwd for `projectPath` matching is read with the selector form
 *   of `useSessions` exactly as the shipped conversation UI reads it:
 *   `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:17749`
 *   (`const cwd = useSessions((s) => sessionId === void 0 ? void 0 :
 *   s.byId[sessionId]?.cwd)`); the field is `SessionSummary.cwd?` in
 *   `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:2967`.
 * - The registration shape (`ctx.slots.inject(name, () => ctx.slots.register({
 *   name, id, order }, Component))`) and the `window.__ModuleLoader__.load`
 *   wrapper follow the shipped UI-plugin template
 *   (`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`)
 *   and `@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js:2919`
 *   for a session-scoped dock-style entry.
 *
 * The component renders `null`: the dock is a full-width stack above the
 * composer card (`:17842`), so anything rendered here would push the composer
 * down. Contract §5.3 explicitly allows the null rendering.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-idea-bridge',
  factory(require) {
    const React = require('react');

    /** Route registered by the host half of this bundle (contract §4). */
    const PENDING_URL = '/idea-bridge/pending';
    /** Route claiming messages for this instance alone (contract §4, v1.1). */
    const CLAIM_URL = '/idea-bridge/claim';
    /** Route acknowledging consumed messages (contract §4). */
    const ACK_URL = '/idea-bridge/ack';
    /** Poll period once the first poll ran (contract §5.1). */
    const POLL_INTERVAL_MS = 400;
    /** Delay before the first poll, so boot requests are not raced (contract §5.1). */
    const FIRST_POLL_DELAY_MS = 300;
    /** `order` 15 sits between the shipped `todo` (0), `goal` (10) and `queue` (20) cells. */
    const DOCK_ORDER = 15;
    /**
     * The plugin context, kept so the dock component can reach the session
     * scope when it needs to insert a real reference chip (contract §5.3).
     */
    let pluginContext;

    /**
     * Format an absolute path as the composer's file mention: `@path`, or
     * `@"path with spaces"`. Mirrors `@deepseek-ai/dsh-file-reference`'s
     * `formatFileMention` (browser-safe grammar shared by both clients).
     */
    function fileMention(path) {
      if (typeof path !== 'string' || path.length === 0) return undefined;
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
      return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
    }

    /** The last path segment, used as the chip label. */
    function baseName(path) {
      const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      return at < 0 ? path : path.slice(at + 1);
    }

    /** `#L<start>` or `#L<start>-<end>`, or '' for a whole-file reference. */
    function lineRange(item) {
      const start = typeof item.lineStart === 'number' ? item.lineStart : 0;
      const end = typeof item.lineEnd === 'number' ? item.lineEnd : 0;
      if (start <= 0 || end <= 0) return '';
      return end > start ? `#L${start}-${end}` : `#L${start}`;
    }

    /**
     * Insert one real reference chip (what typing `@` in the composer produces)
     * instead of flat text: the chip collapses visually and gives DSH a
     * structured file reference.
     *
     * The line range rides inside `ref`/`clipboardText` because DSH's mention
     * grammar is file-level only (there is no `#L` form); that keeps the
     * serialized text byte-identical to the plain-text variant. If the
     * composition rejects the chip (no listener, busy admission phase, unknown
     * session scope), the caller falls back to plain text — never a failure.
     *
     * @param span - collapsed caret span captured from the same draft revision.
     * @param sessionId - session whose scope owns the composer.
     * @param item - the message payload (file + line range).
     * @returns whether a chip was applied.
     */
    function insertReferenceChip(span, sessionId, item) {
      const ctx = pluginContext;
      if (ctx === undefined || typeof ctx.get !== 'function') return false;
      const sessions = ctx.get('sessions');
      if (sessions === undefined || typeof sessions.scope !== 'function' || sessionId === undefined) return false;
      const mention = fileMention(item.file);
      if (mention === undefined) return false;
      /*
       * `ref` must stay a REAL path: the composer resolves it when the chip is
       * clicked or previewed (`openReference` strips the leading `@`), so a
       * `#L` suffix there yields "file does not exist". The line range lives in
       * `clipboardText` only, which is what the message text serializes to.
       */
      const reference = {
        source: 'reference',
        ref: mention,
        label: baseName(item.file),
        appearance: 'file',
        clipboardText: mention
      };
      let scope;
      try {
        scope = sessions.scope(sessionId);
      } catch (_error) {
        return false;
      }
      if (scope === undefined || typeof scope.bail !== 'function') return false;
      try {
        return scope.bail('slash/input-insert-reference', { reference, span }) === true;
      } catch (_error) {
        return false;
      }
    }

    /** One trailing separator is insignificant when comparing two project roots. */
    function normalizePath(value) {
      let end = value.length;
      while (end > 1 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1;
      return value.slice(0, end);
    }

    /**
     * Whether a session cwd names the same project as the message's
     * `projectPath`. Exact match first, then a case-insensitive match (macOS
     * and Windows project roots are routinely spelled differently); symlinked
     * or differently-cased-and-distinct roots are not resolved here, so a
     * mismatch only ever delays delivery to the session that owns the message.
     */
    function sameProject(cwd, projectPath) {
      const left = normalizePath(cwd);
      const right = normalizePath(projectPath);
      return left === right || left.toLowerCase() === right.toLowerCase();
    }

    /** The contract requires `id` and `text`; anything else is not a deliverable message. */
    function isMessage(value) {
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.text === 'string' &&
        value.text.length > 0
      );
    }

    /**
     * The invisible dock cell. It owns only the poll loop; all delivery state
     * lives in refs so the loop is created once per mount.
     */
    function IdeaBridge(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const useSessions = props.useSessions;
      const useInput = props.useInput;

      /*
       * The cwd of this cell's session. `useSessions` is a standard prop of
       * this slot; the guard keeps the component usable if a future
       * composition omits it, in which case delivery degrades to "the current
       * active session" as the contract allows.
       */
      const sessionCwd =
        typeof useSessions === 'function'
          ? useSessions((state) =>
              sessionId === undefined ? undefined : state.byId?.[sessionId]?.cwd
            )
          : undefined;

      /*
       * The draft text the user already typed. The insertion must never wipe it
       * (contract §5.3); this is only read to decide whether a separating space
       * is needed, so an unknown draft degrades to "no pad".
       */
      const draft = typeof useInput === 'function' ? useInput((state) => state?.draft) : undefined;

      const actionsRef = React.useRef(inputActions);
      actionsRef.current = inputActions;
      const cwdRef = React.useRef(sessionCwd);
      cwdRef.current = sessionCwd;
      const draftRef = React.useRef(draft);
      draftRef.current = draft;

      React.useEffect(() => {
        let cancelled = false;
        let inFlight = false;
        /** Ids this instance claimed, i.e. the host created `<id>.claim` for it. */
        const held = new Set();
        /** Ids already written into this session's draft: never submitted twice. */
        const settled = new Set();
        /** Ids written but not yet acknowledged; retried until the ack succeeds. */
        const unacked = new Set();
        /**
         * True once the host answered 404/405 on `/claim`, i.e. it is a v1.0
         * host without the route. Delivery then degrades to v1.0 semantics
         * (no single-flight) instead of stalling silently — contract §5.4,
         * verification defect D6.
         */
        let claimUnavailable = false;
        /** The degradation warning is emitted once per mount, never per tick. */
        let claimDegradationWarned = false;
        let interval;

        /** Acknowledge everything written so far; a failure leaves it queued for the next tick. */
        const flushAcks = async () => {
          if (unacked.size === 0) return;
          const ids = [...unacked];
          const response = await fetch(ACK_URL, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids })
          });
          if (!response.ok) return;
          for (const id of ids) unacked.delete(id);
        };

        /**
         * Ask the host to claim these ids for this instance. The host creates
         * `<id>.claim` with `O_CREAT|O_EXCL`, so of every tab, window and DSH
         * process polling the inbox only the first one gets an id back; the
         * others see it missing from `claimed` and never touch the draft
         * (contract §4/§5, verification defect D2). A failed request claims
         * nothing and is retried on the next tick — except the two permanent
         * answers below, which mean the route does not exist at all.
         */
        const claim = async (ids) => {
          if (ids.length === 0) return;
          if (claimUnavailable) {
            for (const id of ids) held.add(id);
            return;
          }
          const response = await fetch(CLAIM_URL, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids })
          });
          if (response.status === 404 || response.status === 405) {
            /*
             * The host half predates v1.1: there is no claim route. Never stall
             * silently — deliver with v1.0 semantics and say so once.
             */
            claimUnavailable = true;
            if (!claimDegradationWarned) {
              claimDegradationWarned = true;
              console.warn(
                '[dsh-idea-bridge] host has no /idea-bridge/claim (v1.0 host): delivering without single-flight. Restart DeepSeek Harness to load the v1.1 host half.'
              );
            }
            for (const id of ids) held.add(id);
            return;
          }
          if (!response.ok) return;
          const payload = await response.json();
          const granted = Array.isArray(payload?.claimed) ? payload.claimed : [];
          for (const id of granted) if (typeof id === 'string') held.add(id);
        };

        const tick = async () => {
          if (cancelled || inFlight) return;
          if (document.visibilityState !== 'visible') return;
          inFlight = true;
          try {
            await flushAcks();
            const response = await fetch(PENDING_URL, {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { accept: 'application/json' }
            });
            if (!response.ok) return;
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            const cwd = typeof cwdRef.current === 'string' ? cwdRef.current : undefined;
            const candidates = [];
            for (const item of items) {
              if (!isMessage(item) || settled.has(item.id)) continue;
              /*
               * Strict routing (contract §5.2): a message is delivered only to
               * the session whose cwd names its project. An `@/abs/path` chip
               * only resolves against the session's own workspace, so handing
               * it to a session showing a different project would produce a
               * reference the agent cannot read. When no session matches, this
               * plugin deliberately delivers nothing — the IDEA side owns that
               * outcome and reports it (it watches its own inbox file and says
               * "DSH has no session for project X" instead of failing silently).
               */
              if (
                cwd !== undefined &&
                cwd.length > 0 &&
                typeof item.projectPath === 'string' &&
                item.projectPath.length > 0 &&
                !sameProject(cwd, item.projectPath)
              ) {
                continue;
              }
              candidates.push(item);
            }
            await claim(candidates.filter((item) => !held.has(item.id)).map((item) => item.id));
            for (const item of candidates) {
              if (cancelled) return;
              /*
               * Deliver only what this instance holds. An id we already hold
               * but never settled (a previous `setDraft` threw) is retried
               * here, which is why a claim is not re-requested for it.
               */
              if (!held.has(item.id) || settled.has(item.id)) continue;
              const actions = actionsRef.current;
              if (actions === undefined) return;
              try {
                /*
                 * Insert, never replace (contract §5.3): the user's own typing is
                 * the point of the composer. `captureInsertion()` maps to the
                 * caret — or to a selection, which we collapse to its end so an
                 * existing selection is never overwritten.
                 */
                const collapse = () => {
                  const captured = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined;
                  if (captured === undefined) return undefined;
                  const at = typeof captured.end === 'number' ? captured.end : captured.start;
                  return { start: at, end: at, draftRev: captured.draftRev };
                };
                let insertion = collapse();
                if (insertion === undefined) throw new Error('composer has no caret');

                /*
                 * Separate the reference from whatever precedes the insertion
                 * point, without ever producing a double space: pad only when
                 * there IS a preceding character and it is not whitespace.
                 * (An empty draft or a caret at position 0 needs no pad.)
                 * A chip insertion never adds a leading space of its own, so the
                 * pad is applied as its own edit before either path.
                 */
                const draft = draftRef.current;
                let padded = false;
                if (typeof draft === 'string' && draft.length > 0 && insertion.start > 0) {
                  const before = insertion.start <= draft.length
                    ? draft[insertion.start - 1]
                    : draft[draft.length - 1];
                  padded = !/\s/.test(before);
                }
                if (padded) {
                  if (actions.insertText(' ', insertion) !== true) throw new Error('composer rejected the separator');
                  insertion = collapse();
                  if (insertion === undefined) throw new Error('composer has no caret after the separator');
                }

                /*
                 * Prefer a real reference chip (collapses like a typed `@`); fall
                 * back to flat text when the composition refuses it. Either way the
                 * serialized text is `@<path>#L<a>-<b> `.
                 */
                const chipped = insertReferenceChip(insertion, sessionId, item);
                if (!chipped && actions.insertText(item.text, insertion) !== true) {
                  throw new Error('composer rejected the insertion');
                }
                /*
                 * The content is in the composer now. Record it BEFORE anything
                 * else can fail: a throwing `submit()` (or a later ack problem)
                 * must never re-insert the same reference into the draft, which
                 * is how one message could otherwise leave several chips.
                 */
                settled.add(item.id);
                unacked.add(item.id);
                /*
                 * A chip is a file reference and carries no line range (DSH's
                 * mention grammar is file-level), so the range follows the chip
                 * as text: `[chip] #L10-20`. That is what the agent reads. A
                 * failure here must never cause a second insertion.
                 */
                if (chipped) {
                  const range = lineRange(item);
                  if (range !== '') {
                    try {
                      const after = collapse();
                      if (after !== undefined) actions.insertText(range, after);
                    } catch (_error) {
                      /* chip delivered without its range; still acked */
                    }
                  }
                }
                if (item.submit === true && typeof actions.submit === 'function') {
                  try {
                    actions.submit();
                  } catch (_error) {
                    /* Left as a draft on purpose; the user can press Enter. */
                  }
                }
              } catch (_error) {
                /* Still held, still unsettled: the next tick retries the write. */
                continue;
              }
            }
            await flushAcks();
          } catch (_error) {
            /* Network or bridge absence: the next tick retries. */
          } finally {
            inFlight = false;
          }
        };

        const first = setTimeout(() => {
          void tick();
          interval = setInterval(() => {
            void tick();
          }, POLL_INTERVAL_MS);
        }, FIRST_POLL_DELAY_MS);

        return () => {
          cancelled = true;
          clearTimeout(first);
          if (interval !== undefined) clearInterval(interval);
        };
      }, []);

      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Kept for the chip path: the dock component reaches the session scope
        // through this context (contract §5.3).
        pluginContext = ctx;
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'idea-bridge', order: DOCK_ORDER },
            IdeaBridge
          )
        );
      }
    };
  }
});
