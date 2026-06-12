import { useEffect } from 'react';
let _inertCount = 0;
function acquireInert(): void {
  _inertCount += 1;
  if (_inertCount === 1) {
    const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
    if (root) root.setAttribute('inert', '');
  }
}
function releaseInert(): void {
  if (_inertCount <= 0) return;
  _inertCount -= 1;
  if (_inertCount === 0) {
    const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
    if (root) root.removeAttribute('inert');
  }
}
export function useBackgroundInert(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    acquireInert();
    return () => { releaseInert(); };
  }, [open]);
}
export function _resetInertCount(): void {
  _inertCount = 0;
  if (typeof document !== 'undefined') {
    const root = document.getElementById('root');
    if (root) root.removeAttribute('inert');
  }
}
