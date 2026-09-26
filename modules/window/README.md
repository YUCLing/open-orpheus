# window

Window management module for Open Orpheus

## Wayland layer shell

On compositors that implement `zwlr_layer_shell_v1` (wlroots-based ones and
KWin), a window can be created as a layer surface rather than an ordinary
toplevel. That is what lets an overlay window choose its layer, anchors, size,
margins and keyboard interactivity, instead of depending on window-manager
rules.

A compositor assigns a surface its role when a role object is created for it and
never lets the surface take another one, so the API is a declaration rather than
a property:

- `useLayerShellForNextWindow(options)` queues a declaration for the next
  toplevel the display connection creates.
- `cancelLayerShellForNextWindow()` withdraws a declaration that has not been
  consumed yet (they also expire on their own).
- `validateLayerShellOptions(options)` runs the same checks without queueing
  anything, so a caller can report a declaration that could never be sent.
- `isLayerShellAvailable()` reports whether the compositor advertises the
  protocol. Everywhere but Wayland on Linux it is `false`.

Because the queue is positional, a declaration has to be armed _and_ consumed by
the surface it describes: arm it immediately before that surface is created and
never leave one pending, or the next window on the connection inherits it.

A declaration that says nothing about size or anchors covers the output (all
four anchors, size chosen by the compositor). An axis given a size of `0` must
anchor both opposite edges there, so combinations that cannot be sent are
refused rather than allowed to raise a protocol error.

The role belongs to the `wl_surface`, and the compositor keeps it after the
client destroys its role object. Hiding and showing a window makes the client
create a new `xdg_toplevel` over the _same_ surface, and asking for a toplevel
there is a protocol error (KWin: `already_constructed`), so the proxy remembers
the declaration per surface and converts the new role object again. The memory
dies with the surface, which is what makes the reverse direction possible:
turning a converted window back into an ordinary toplevel needs the surface
itself recreated — for `ManagedWindow`, that means recreating the window.

The proxy behind the module does the actual work: it watches `wl_registry` for
the global, intercepts the client's `xdg_surface.get_toplevel`, and replaces it
with `zwlr_layer_shell_v1.get_layer_surface` followed by the requested state.
From then on the compositor sees a layer surface while the client keeps speaking
xdg-shell, so the proxy suppresses or translates the xdg-shell traffic for that
window and synthesises the configure and close events the client is waiting for.
A window whose preconditions are not met (no global, no spare object id, an
unknown surface) is left an ordinary toplevel rather than risking a protocol
error, which would take the whole display connection down.

Application code does not call any of this directly. `ManagedWindow` owns it:
`setLayerShell(options)` records the state, `beforeSurfaceCreated()` is where a
window class declares that it _is_ a layer surface, and a declaration is armed
immediately before each action that brings a surface with it — the window's
creation when it is created shown, and the show of a hidden window. A client
that creates its windows hidden (Electron does, for `show: false`) therefore
takes the role on the first show, not at construction; arming it earlier would
leave a declaration pending for whatever surface appeared next. `setLayerShell(null)`
clears the recorded state.

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
