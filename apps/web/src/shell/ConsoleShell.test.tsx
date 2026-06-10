import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConsoleShell } from './ConsoleShell.js';

describe('ConsoleShell', () => {
  it('renders all five zones with semantic landmarks', () => {
    render(
      <ConsoleShell
        top={<div>top-zone</div>}
        left={<div>left-zone</div>}
        globe={<div data-testid="globe">globe-zone</div>}
        right={<div>right-zone</div>}
        bottom={<div>bottom-zone</div>}
      />,
    );
    expect(screen.getByText('top-zone')).toBeInTheDocument();
    expect(screen.getByText('left-zone')).toBeInTheDocument();
    expect(screen.getByText('right-zone')).toBeInTheDocument();
    expect(screen.getByText('bottom-zone')).toBeInTheDocument();
    expect(screen.getByTestId('globe')).toBeInTheDocument();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByLabelText('Layers')).toBeInTheDocument();
    expect(screen.getByLabelText('Selection')).toBeInTheDocument();
  });
});
