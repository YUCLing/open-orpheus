/** Never let one failing callback skip remaining cleanup or escape into N-API. */
export function runMenuCallbacks(callbacks: Array<() => void>, onError: (error: unknown) => void) {
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      try {
        onError(error);
      } catch {
        /* Reporting must not interrupt disposal. */
      }
    }
  }
}

/** A timer belongs to its cleanup list only while it is pending. */
export function scheduleMenuTask(
  callback: () => void,
  delay: number,
  resources: Array<() => void>
): () => void {
  let pending = true;
  const cancel = () => {
    if (!pending) return;
    pending = false;
    clearTimeout(timer);
    const index = resources.indexOf(cancel);
    if (index !== -1) resources.splice(index, 1);
  };
  const timer = setTimeout(() => {
    if (!pending) return;
    // Detach before calling user code, including callbacks that close the menu
    // or throw. Cancellation remains safe after execution and after disposal.
    cancel();
    callback();
  }, delay);
  resources.push(cancel);
  return cancel;
}

export function isLiveFocusedWindow(
  window: { isDestroyed(): boolean; isFocused(): boolean } | null
) {
  return Boolean(window && !window.isDestroyed() && window.isFocused());
}
