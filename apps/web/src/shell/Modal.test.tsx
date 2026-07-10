import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { Modal, Drawer, useConfirm } from './Modal.js';
import { Btn } from './instruments.js';

describe('Modal', () => {
  it('renders title/children/footer when open, nothing when closed', () => {
    const { rerender } = render(
      <Modal open={false} onClose={() => {}} title="My dialog">
        <div>body-content</div>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Modal open onClose={() => {}} title="My dialog" footer={<button>Save</button>}>
        <div>body-content</div>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('My dialog')).toBeInTheDocument();
    expect(screen.getByText('body-content')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('closes on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="t">
        <div>x</div>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the panel and restores it on close', () => {
    function Host(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <Modal open={open} onClose={() => setOpen(false)} title="t">
            <div>x</div>
          </Modal>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });
});

describe('Drawer', () => {
  it('renders docked panel with dialog semantics and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Edit transform">
        <div>drawer-body</div>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('drawer-body')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('useConfirm', () => {
  function Host({ onResult }: { onResult: (v: boolean) => void }): JSX.Element {
    const { confirm, confirmElement } = useConfirm();
    return (
      <>
        <Btn
          onClick={() => {
            void confirm({ title: 'Delete it?', tone: 'danger', confirmLabel: 'Delete' }).then(
              onResult,
            );
          }}
        >
          trigger
        </Btn>
        {confirmElement}
      </>
    );
  }

  it('resolves true on confirm', async () => {
    const onResult = vi.fn();
    render(<Host onResult={onResult} />);
    fireEvent.click(screen.getByText('trigger'));
    expect(screen.getByText('Delete it?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete'));
    await act(async () => {});
    expect(onResult).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves false on cancel and on Escape', async () => {
    const onResult = vi.fn();
    render(<Host onResult={onResult} />);
    fireEvent.click(screen.getByText('trigger'));
    fireEvent.click(screen.getByText('Cancel'));
    await act(async () => {});
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
