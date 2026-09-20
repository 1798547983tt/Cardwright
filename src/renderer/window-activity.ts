/** Marks the document inactive while the window is blurred or hidden so decorative loops can pause. */
export function watchWindowActivity(): () => void {
  const root = document.documentElement;
  const update = () => { root.dataset.window = document.visibilityState === 'visible' && document.hasFocus() ? 'active' : 'inactive'; };
  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}
