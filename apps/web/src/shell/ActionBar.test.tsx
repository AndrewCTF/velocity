import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ActionBar } from './ActionBar.js';
import { useFilters, useSelection } from '../state/stores.js';

// The action bar shipped as four literals: a filter button with no handler, a
// hardcoded "Showing all contact types across the current view" that stayed put
// while filters changed, a Clear selection that cleared nothing, and a primary
// "Add to filter path" for a capability that does not exist. These assert the
// row reports the stores rather than a sentence someone typed.

describe('ActionBar', () => {
  beforeEach(() => {
    useFilters.getState().clear();
    useSelection.getState().select(null);
  });

  it('picking a contact type writes a real filter clause', () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole('button', { name: /Filter contact type/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Tanker vessels' }));
    expect(useFilters.getState().clauses).toEqual([
      { facet: 'vesselType', value: 'tanker', mode: 'only' },
    ]);
  });

  it('the sentence states the active query, not a fixed string', () => {
    render(<ActionBar />);
    expect(screen.getByText(/all contact types/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Filter contact type/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Military aircraft' }));
    expect(screen.getAllByText(/Military aircraft/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/all contact types/)).not.toBeInTheDocument();
  });

  it('names which facet a clause came from, since both carry a military bucket', () => {
    useFilters.getState().toggleClause('vesselType', 'military', 'only');
    render(<ActionBar />);
    // Both the sentence and the chip name it, which is the point.
    expect(screen.getAllByText(/Military vessels/).length).toBe(2);
  });

  it('a chip removes the one clause it names', () => {
    useFilters.getState().toggleClause('aircraftCategory', 'helicopter', 'only');
    useFilters.getState().toggleClause('vesselType', 'tanker', 'only');
    render(<ActionBar />);
    fireEvent.click(screen.getByRole('button', { name: /Helicopter aircraft/ }));
    expect(useFilters.getState().clauses).toEqual([
      { facet: 'vesselType', value: 'tanker', mode: 'only' },
    ]);
  });

  it('Clear selection is disabled with nothing selected and clears when there is', () => {
    const { rerender } = render(<ActionBar />);
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeDisabled();

    useSelection.getState().select('aircraft:abc123');
    rerender(<ActionBar />);
    const btn = screen.getByRole('button', { name: 'Clear selection' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(useSelection.getState().selectedEntityId).toBeNull();
  });

  it('Clear filters is disabled with no filters and drops them all when there are', () => {
    const { rerender } = render(<ActionBar />);
    expect(screen.getByRole('button', { name: /Clear filters/ })).toBeDisabled();

    useFilters.getState().toggleClause('aircraftCategory', 'airliner', 'only');
    rerender(<ActionBar />);
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(useFilters.getState().clauses).toEqual([]);
  });
});
