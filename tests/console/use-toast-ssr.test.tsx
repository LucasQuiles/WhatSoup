/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { ToastProvider } from '../../console/src/hooks/use-toast';

describe('ToastProvider SSR guard', () => {
  it('renders without document by inlining the toast stack instead of creating a portal', () => {
    expect(typeof document).toBe('undefined');

    const html = renderToString(
      <ToastProvider>
        <span>child content</span>
      </ToastProvider>,
    );

    expect(html).toContain('child content');
  });
});
