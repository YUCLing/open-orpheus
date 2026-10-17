# window

Window management module for Open Orpheus

## Object model

On Wayland the proxy sits on the client's display connection and speaks for a
window the client believes is an `xdg_toplevel`. Four facts explain nearly
everything it does:

- **The id rides in the title.** The application writes
  `prefix + managed id + separator + real title`; the proxy takes the id and
  forwards only the real title. `xdg_toplevel.set_title` is the only
  client-controlled string that arrives after `xdg_surface.get_toplevel`, and a
  compositor requires a role object before a title can be set — so the id cannot
  be learned any earlier.
- **A surface's role is permanent.** A compositor assigns a `wl_surface` its
  role once and never releases it while the surface lives. The proxy therefore
  decides the role exactly once per surface and re-applies it to every later role
  object the client builds on that surface (which is what hiding and showing
  does).
- **A `new_id` the proxy suppresses must stay dense.** Libwayland rejects a
  client's next id if the compositor's object map has a hole at the growing
  edge, so a suppressed `new_id` is replaced by a throwaway `wl_display.sync` on
  the same id.
- **State is keyed by managed window id, not by the Electron window.** The id is
  generated before the `BrowserWindow` exists, which is what lets a policy be
  registered ahead of the first role and an input region be recorded before its
  surface is known.

### What lives where

| State                                                       | Key                                | Lives until                  |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| `WaylandConn::surface_ids`                                  | `wl_surface` → managed id          | the surface is destroyed     |
| `WaylandConn::surface_roles`                                | `wl_surface` → `SurfaceRole`       | the surface is destroyed     |
| `WaylandConn::layer_windows`, `wl_to_layer`, `xdg_to_layer` | the per-show role objects          | the role object is destroyed |
| `WaylandConn::pending_role`                                 | the open role transaction          | it is decided                |
| `WINDOW_ROLES`                                              | managed id → the role it asked for | consumed, or cleared         |
| `RECORDED_INPUT_REGIONS`                                    | managed id → input region          | cleared by the application   |
| `WaylandConn::injected_ids`, `stolen_ids`                   | the proxy's own object ids         | the id is recycled           |

There is no `managed id → surface` map: that would duplicate `surface_ids` with
its own invalidation rules, so `state::window_surface` derives it by scanning the
handful of live connections.

## Wayland layer shell

On compositors that implement `zwlr_layer_shell_v1` (wlroots-based ones and
KWin), a window can be created as a layer surface rather than an ordinary
toplevel. That is what lets an overlay window choose its layer, anchors, size,
margins and keyboard interactivity, instead of depending on window-manager
rules.

A compositor assigns a surface its role when a role object is created for it and
never lets the surface take another one, so the role is decided **once per
surface** and the API is a policy registered ahead of that decision:

- `setWindowLayerShell(windowId, options)` registers (or replaces) the policy for
  a managed window; `setWindowLayerShell(windowId, null)` clears it.
- `validateLayerShellOptions(options)` runs the same checks without storing
  anything, so a caller can report options that could never be sent.
- `isLayerShellAvailable()` reports whether the compositor advertises the
  protocol. Everywhere but Wayland on Linux it is `false`.

The policy is keyed by the id the application names the window with, so it can be
registered before the window — and therefore before its surface — exists. Options
that say nothing about size or anchors cover the output (all four anchors, size
chosen by the compositor). An axis given a size of `0` must anchor both opposite
edges there, so combinations that cannot be sent are refused rather than allowed
to raise a protocol error.

### The role transaction

Chromium creates one `wl_surface` per `BrowserWindow` at construction and keeps
it for the window's life; hiding and showing the window creates a new
`xdg_surface` and `xdg_toplevel` over that _same_ surface, re-asserting the
window's properties including the title. A role object cannot be created before
its title, and the proxy cannot name the window before that title, so:

- The surface's **first** `xdg_surface.get_toplevel` opens a transaction, and the
  requests that belong to the role being built — those addressed to the new
  toplevel or its `xdg_surface`, its surface `commit`, its decoration and icon
  requests — are held. The decorated title
  (`prefix + managed id + separator + real title`) names the window; its policy
  is read, the role is decided, and the held requests are replayed through the
  normal dispatch, in order — where a converted window's shadow handlers take
  over. The transaction also ends as an ordinary toplevel when the role object
  or its surface is destroyed, when the surface commits before a title names it,
  or after 32 held requests.
- Any **other** request completes the transaction first and is then dispatched
  normally, never held. Two reasons: a held request that allocates a new object
  id would otherwise be sent after the `get_toplevel` this transaction holds,
  leaving a hole the compositor refuses; and a request can carry file
  descriptors, which travel with the message and would be closed on a message the
  proxy does not forward.
- Every **later** role object on the same surface is answered from the cached
  decision: the proxy re-emits `get_layer_surface` (or forwards `get_toplevel`)
  with no title needed and no buffering.

`get_xdg_surface` is held with the rest of the block and only replayed when the
outcome is not a layer surface. It has to be: the role belongs to the
`wl_surface`, and a compositor is free to claim it in `get_xdg_surface` rather
than in `get_toplevel` — wlroots does, KWin does not. Forwarding it and
replacing only `get_toplevel` therefore works on KWin and kills the connection
on Sway or Hyprland with "surface already has a role". Withholding it makes the
outcome independent of where the compositor claims the role. Replacing
`get_toplevel` on its own id keeps the compositor's object map dense; only the
decoration constructor introduced by a converted role needs the
`wl_display.sync` id plug described below.

The role belongs to the `wl_surface`, and the compositor keeps it after the
client destroys its role object. That is why a surface which ever took the
toplevel role can never become a layer surface: asking is a fatal protocol error
(`already_constructed`). The proxy refuses instead, reports the window through
`onLayerShellRoleRefused` once per surface, and leaves it an ordinary toplevel —
turning it into a layer surface needs the surface itself recreated, which for
`ManagedWindow` means recreating the window.

The proxy behind the module does the actual work: it watches `wl_registry` for
the global, intercepts the client's `xdg_surface.get_toplevel`, and replaces it
with `zwlr_layer_shell_v1.get_layer_surface` followed by the requested state.
From then on the compositor sees a layer surface while the client keeps speaking
xdg-shell, so the proxy suppresses or translates the xdg-shell traffic for that
window and synthesises the configure and close events the client is waiting for.
Every id the client allocates for a window the compositor is not allowed to
create an object for is **reserved**: a `wl_display.sync` callback takes the id
without claiming anything. This is not optional. The compositor's object map
grows one slot at a time and only accepts an id inside the range it has already
grown to, so a dropped `new_id` is a hole that the client's next allocation falls
into — the compositor refuses it and takes the whole connection down.

The reservation has two lifetimes, though, not one: the compositor is done with
the callback the moment it answers it, while the client keeps — or destroys — its
object whenever it likes, and either can finish first. So the proxy answers for
the object out of its own tables the whole time, hides the callback's events
until it has answered, and releases the id only when **both** are done: whichever
finishes second does the releasing. The id is never recycled into the proxy's own
pool, because it belongs to the client.

That covers the teardown — the client destroys its toplevel, its `xdg_surface`
and their decoration in that order, and each destroy is answered by the proxy
rather than forwarded — and requests that merely _name_ one of these ids. A
decoration or an icon for a toplevel the compositor never created is answered
locally too: forwarding one would name an object that is not there.

A surface's role is even stickier than its role object. Once a `wl_surface` has
held the layer role it can never hold another one — the role _type_ is only ever
replaced by the same type, and only after the role object is gone. So a window
whose layer surface cannot be rebuilt (the compositor withdrew the global, say)
is not handed back as an ordinary toplevel: its ids are reserved, the cached
decision is kept, and a later show retries it. A window whose preconditions are
not met on its **first** show is left an ordinary toplevel instead, which is safe
because that surface has not held a role yet.

Application code does not call any of this directly. `ManagedWindow` owns it:
`setLayerShell(options)` registers the policy with the native layer, and a window
class calls it before `createBrowserWindow`, so the policy exists before its
window — and therefore its first role object — does. A surface that already took
a role keeps it for its life, so `setLayerShell(null)` only takes effect on the
window's next surface (a recreated window). Input regions follow the same
ownership: the native layer records them against the window id and emits them
immediately before the surface's next `commit`, because a `set_input_region` is
only adopted at a commit — injecting one after the batch, as the app-facing
socketpair path does, leaves the window on its previous region. Attaching the id
to a surface re-marks the record, so a re-created surface gets the region again,
and a region whose object id is unavailable stays pending instead of being
reported as applied.

### xdg_popup

A managed window can be presented to the compositor as an `xdg_popup` of another
managed window while the client keeps speaking `xdg_toplevel` — that is how a
menu becomes a real popup instead of a fullscreen overlay. It is registered the
same way as a layer policy — both live in `WINDOW_ROLES`, because a window takes
exactly one role: `setWindowPopupPolicy(targetId, parentId, …)` records the
intent and the measured size against the **target** window id, and the role
transaction consumes it when the decorated title names that window. Only the
intent is recorded: the parent's `xdg_surface`, the anchor and the positioner
object id are resolved when the role is created. Registration does have to find
the parent mapped, and it does that lookup and the publish under one lock, so a
connection closing in between cannot leave a policy naming a descriptor that is
gone — or that some later connection has reused. A window whose surface already
took a role is refused up front, before the caller shows an ordinary toplevel it
would then have to replace.

At the role decision `get_toplevel` is replaced by the
`create_positioner` → `get_popup` sequence, and the window is marked
`XdgPopupShim`: `xdg_popup.configure` becomes an `xdg_toplevel.configure` with
the shadow inset added back, `xdg_popup.popup_done` is forwarded (opcode 1 is
`close` for a toplevel), the other popup events are suppressed and the
toplevel-only requests are swallowed. The application still confirms the
conversion with `isWindowWaylandPopup`, because a policy can be refused — and it
keeps its overlay fallback for that. An `xdg_positioner` needs a size before
`get_popup`, and only the renderer knows the measured menu size, so the policy is
re-registered for each window rather than once per class.

### Moving and resizing a converted window

Layer shell has no equivalent of either: a layer surface's position and size
belong to the application, and only `set_margin` and `set_size` change them. A
converted client asks for both anyway — `xdg_toplevel.move` from the window's own
drag, `resize` from its edge hit test — so the proxy replays the gesture itself,
from the two things a client is told about it: where the pointer is within the
surface, and the geometry the surface has.

What a gesture is after is one number: how far the pointer has moved since it
grabbed the window — and a motion event already says exactly that. For as long
as the button is down the compositor keeps measuring the pointer against the
geometry the press was made on, so the pointer's place in those coordinates is
the place it grabbed the window at plus everything it has done since. The
window's own movement is deliberately not in the numbers, and that is the whole
reason the emulation works: a gesture that rewrites the window's margins can
read its own progress back out of the pointer. A resize comes out of the same
movement, which is also what keeps the edge the user did not grab exactly where
it was.

The one thing a step must never be is the previous step plus a bit. The
pointer's place in the surface is measured from the press, not from the geometry
the last step asked for, so a step added to a step counts everything the drag
has done again on every motion event: eight events of ten pixels would carry the
window eighty pixels past where it belongs rather than eighty in all. Every step
is computed from the gesture's start instead, so a batch of motion events lands
the window exactly where a single one would. What the window's commits are for
is making the geometry take effect at all: they are what the arrangement
follows, which is the next paragraph.

Two conditions have to hold, and a gesture that fails either is dropped — with
`ORPHEUS_LAYER_DEBUG` set, the proxy prints what it made of each one:

- **The margin is the position.** Only a surface anchored to the top and left
  edges can be driven this way; any other shape is placed by the compositor, and
  a client cannot read where that is. `set_margin` and `set_size` from the
  application are unaffected by this — they are its own to say.
- **The serial has to be one this surface received.** `move` and `resize` name
  the press (or the pointer enter) that started them, and the proxy only replays
  a gesture it can match against the press it recorded for that surface.

A gesture also has to know where the window stops being reachable — and so does
the window itself, because a placement is margins from one output's corner: a
window created with another screen's placement is off the one it lands on,
clipped out of sight and past the reach of any pointer, with nothing left that
could bring it back. The layer role cannot be moved to another output either —
the protocol has no request for it, and the role is fixed when the surface is
created — so a drag towards a second monitor would carry the window off the edge
of the one it lives on, which is also the edge that feeds the gesture its motion.

Both questions have the same answer, and there are three of them, best first:

- the client's own `zxdg_output_v1` for the output the surface entered, in the
  logical coordinates the margins are measured in;
- that output's `wl_output` mode over its scale, for a client that made no such
  object — rounded down, since a size that is too small holds a window further
  inside its screen while one that is too large lets a drag take it off an edge
  it cannot come back from;
- `setWindowLayerBounds(windowId, width, height)`: the size the application
  measured on its own screen, for a client that bound neither.

A gesture keeps the _whole_ window inside that size, and a window that turns up
outside it — created with a placement from another screen, or restored from one,
or larger than the screen itself — is pulled back in as soon as its surface says
which output it is on. Whole rather than partly, for two reasons that both cost
the user the window: the part of it that accepts the pointer is the part that
has something to show, so a strip over the edge is a strip that cannot be
grabbed; and a compositor arranges a surface anchored to the top left by the
room left on the output, so one hanging over the edge is _shrunk_ to fit, which
would leave the geometry a gesture believes in a lie. What follows from that is
also what makes a drag past the edge legible: with the window flush against it,
the pointer leaves the window at the moment it leaves the screen, so the edge
the user pushed through is the edge they crossed. Without a size at all there is
nothing to hold it by, and a gesture that loses its surface is undone instead —
the fallback, not the rule.

A window pinned at an edge is as far as a gesture can take it. A button press
holds the pointer to the window it was made on, so the motion events keep coming
even once the pointer has been dragged clear of the window — which a window that
follows the pointer never lets happen — and a gesture that ends that way is a
user pushing past the edge of the screen. The proxy reports it, with the edges it
was pinned against, through `onLayerSurfacePushed`; moving the window further is
a decision only the application can make, because it means creating the window
again — a layer surface keeps its output for life, and there is no request that
changes it. A policy may name the output it wants (`LayerShellOptions::output`,
matched against every name the client's `wl_output` and `zxdg_output_v1` gave
that output), and `onLayerSurfaceOutput` reports the output a converted window
ended up on in those same names: a window created again can be asked for by what
the proxy itself said, with nothing in between to match up.

These requests cannot travel the injection path everything else uses. The id they
name is a layer surface to the compositor and the client's `xdg_toplevel` to the
filter, and the client's namespace reads the layer opcodes as different
xdg-toplevel ones — `set_size` is opcode `0`, the toplevel's `destroy`. They are
therefore written straight to the compositor under the connection's write lock,
which is what keeps a short direct write from interleaving with a forwarded
chunk.

The same lock is what keeps such a request from naming an object the compositor
has already been told to forget, which is a protocol error that takes the whole
display connection down with it: the client can destroy the surface at any
moment, from its own thread. Resolving the window and writing the group are
therefore one critical section, taken in the order the proxy's own outbound path
takes its locks — the write lock first, the connection state under it. A window
still recorded once that lock is held is one whose destroy has not been forwarded
yet, because forwarding is what holds the same lock and destroying the surface is
what removes the record.

Each one is followed by a `wl_surface.commit` on the same surface, which the
proxy also emits. Layer-surface state is double-buffered — the compositor adopts
it at the surface's next commit — so the commit is what makes the change take
effect at all. A commit that attaches no new buffer is legal, and the client's
own commits are unaffected. Whether a compositor reads such a commit as a change
to arrange is its own business, and at least one does not; the mechanism that
always works is the client's own commit, which is why an application that wants
a drag to follow the pointer has to keep the window drawing while the pointer is
on it. `gui/src/lib/paintPulse.ts` is that half: an imperceptible repaint for as
long as the user is working in the window, so the window is never idle in the
middle of a drag.

A gesture ends when the button is released, and the geometry it leaves behind is
what the window keeps. Where the screen's size is unknown, a gesture that loses
its surface is **undone** first: the window can have been dragged anywhere, and
the place the gesture found it in is the one outcome that cannot strand it
off-screen. With the size known there is nothing to undo — the window is held
inside the screen — so the gesture stays in flight for a pointer that has been
dragged off the window, and the button is what decides what that meant. Dragging
a layer surface between outputs needs the surface itself recreated on the other
output, which is a decision only the application can make.

The geometry a gesture leaves behind is remembered three times over: in the
cached role decision, so hiding and showing the window (a new role object on the
same surface) puts it back where it was; in the window's policy, so a window the
application destroys and builds again under the same managed id comes back there
too; and in a report to the application, through `onLayerSurfaceGeometry`, since
a compositor never tells a client where a layer surface is and an application
that persists a placement has nowhere else to read it from.

An application-side resize goes through `setWindowLayerSize(windowId, width,
height)`: a converted client cannot resize itself, because the buffer it would
attach is not the one the compositor keeps the surface at. Electron's own
`setSize` still works on the window it looks like, and the compositor's configure
brings the window to the size the layer surface was given, so a caller that
resizes a layer window resizes the surface instead.

### What a converted client does that has to be shadowed

A real client speaks more xdg-shell than `get_toplevel`, and some of those calls
name the toplevel the compositor never created, so forwarding one is fatal:

- `zxdg_decoration_manager_v1.get_toplevel_decoration(xdg_toplevel)` names a
  toplevel the compositor never created. The request is swallowed, the client is
  given `client_side` decorations directly, and the decoration object is tracked
  so its later requests stay off the wire.
- `xdg_toplevel_icon_manager_v1.set_icon(xdg_toplevel, icon)` names it too. The
  icon object the client built is real and lives on normally; only the
  assignment to the window is dropped.
- A `new_id` the proxy suppresses would leave a hole in the compositor's object
  map at the edge it is still growing, and the next id the client allocates is
  then refused (`not a valid new object id`). The suppressed request is therefore
  replaced by a throwaway `wl_display.sync` on the same id, whose `done` and
  `delete_id` are swallowed. That id is kept out of the injected-id pool for as
  long as the client still owns its shadow object.

All three behaviours were found by running a converted window against KWin.

## X11 background windows

`setWindowAsBackground(hwnd)` is the X11 counterpart of a Wayland background
layer surface: on an X11 session it makes the window the bottom of the managed
stack. It writes one property:

- `_NET_WM_STATE` = `_NET_WM_STATE_BELOW` + `_NET_WM_STATE_STICKY`

`_NET_WM_STATE_BELOW` is the layer directly above the window manager's own
desktop window, which is where a wallpaper-like window belongs;
`_NET_WM_STATE_ABOVE` is the layer above _normal_ windows, and the two states
contradict each other, so it is never set. `_NET_WM_STATE_STICKY` keeps the
window on every workspace, the way a background belongs to all of them.

The window deliberately keeps whatever type the client gave it (Chromium sets
`_NET_WM_WINDOW_TYPE_NORMAL`). Setting `_NET_WM_WINDOW_TYPE_DESKTOP` as well was
tried first and does not work: the window manager owns the desktop layer itself
and strips `_NET_WM_STATE_BELOW` from a desktop-typed window, so the property
comes back empty and the window ends up with neither the state nor a defined
place in the managed stack — measured on KWin with `xprop`. A normal window that
asks to be kept below the others is the placement that actually holds.

The property is written with a `ChangeProperty` request injected straight to the
server over the window's own connection, exactly like the input region. Its type
is `XA_ATOM` and the value words are written in the client's byte order (the
server swaps them when the orders differ), so the request is valid on a big-endian
client too.

Everything the injection needs is interned once per connection, in the same probe
block that interns `_NET_WM_MOVERESIZE` right after the X11 handshake
(`_NET_WM_STATE`, `_NET_WM_STATE_BELOW` and `_NET_WM_STATE_STICKY`). A call that
arrives before those replies have been harvested sends nothing and returns
`false`, so the caller can retry; a window manager that does not implement EWMH
simply ignores the property.

Wayland on Linux throws instead, because the layer-shell background layer is the
same feature there. `ManagedWindow`-based windows reach this through
`MusicDesktopWindow`, which calls it for a non-Wayland Linux session. A
background window is not a window _on_ the screen but the screen itself, so that
caller also sizes the window to the display — on Wayland the layer surface's four
anchors do that on their own, and nothing else would.

## Building

`pnpm build:modules` from the repository root builds every module; `pnpm build`
inside this directory builds only this one.

`index.js` and `index.d.ts` are generated by the napi CLI from the `#[napi]`
wrappers in `src/lib.rs`, so they are never edited by hand: a new function
reaches the application by getting a wrapper there and rebuilding, and a
hand-written line in either file is gone at the next build.

The application imports these functions by name, which makes an out-of-date
binding fail early and loudly: Electron cannot start at all, and the error is
`Named export 'X' not found ... is a CommonJS module`. The rebuild is the fix.
`isLayerShellNativeComplete` in `src/main/window.ts` covers the narrower case
where the wrapper exists but the binary behind it does not, and falls back to
ordinary windows with a message saying so.
