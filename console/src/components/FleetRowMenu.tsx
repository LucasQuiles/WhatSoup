/**
 * FleetRowMenu.tsx — per-row action surface for the SOUP v3 fleet table.
 *
 * Adopts the Menu primitive (showcase §22; DD-43) as the trailing kebab on each
 * Lines-table row. The line lifecycle actions already exist on the API client —
 * this only WIRES them through the Menu, reusing the established handler / toast /
 * confirm pattern from ActivityFeed (handleRestart/handleStop) and Ops/LineDetail
 * (api.deleteLine behind a ConfirmDialog with the canonical delete copy).
 *
 * Capability gate: mirrors ActivityFeed, which renders an action only when the
 * row is actionable (`canAct ? handler : undefined`). Here the whole menu is
 * gated — when `canAct` is false the kebab is not rendered at all, so the row
 * exposes no lifecycle actions (parity with ActivityFeed hiding restart/stop).
 *
 * Destructive routing: Delete is a `destructive` MenuItem, so the primitive
 * closes the surface and raises ConfirmDialog (confirmVariant="danger") natively
 * — api.deleteLine fires only after the operator confirms, never on the menu
 * click. Stop is likewise gated behind confirm (stopping disconnects the line),
 * matching ActivityFeed's stop-confirm flow. Restart fires directly, matching
 * the LineDetail header Restart button.
 *
 * Styling: the Menu owns its surface styling; the kebab trigger reuses the
 * `.soup-menu-trigger` recipe with the `--icon` modifier (square, icon-only) so
 * no raw px/hex enters the consumer. The trigger stops propagation so opening the
 * menu never triggers the row's open-drawer activation.
 */
import { type FC, useCallback } from 'react';
import { MoreVertical, RotateCw, Square, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../hooks/toast-context';
import { api } from '../lib/api';
import { displayInstanceName } from '../lib/text-utils';
import { Menu, MenuItem, MenuSection, MenuSeparator } from './primitives';

export interface FleetRowMenuProps {
  /** Line name (the API key for every lifecycle call). */
  name: string;
  /**
   * Capability gate — when false the menu is not rendered (no lifecycle
   * actions exposed for this row). Mirrors ActivityFeed's per-row `canAct`.
   */
  canAct: boolean;
}

const ICON = 14;

/**
 * Trailing kebab action menu for a fleet-table row. Returns null when the
 * caller lacks the capability, so an ungated row renders no actions at all.
 */
export const FleetRowMenu: FC<FleetRowMenuProps> = ({ name, canAct }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const label = displayInstanceName(name);

  // Restart — fires directly (no confirm), matching the LineDetail header
  // Restart button: optimistic toast, then success/failure toast.
  const handleRestart = useCallback(() => {
    toast.info(`Restarting ${label}...`);
    api
      .restart(name)
      .then(() => toast.success(`${label} restart requested`))
      .catch((err: unknown) =>
        toast.error(
          `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [name, label, toast]);

  // Stop — routed through ConfirmDialog (destructive) because stopping
  // disconnects the line, mirroring the ActivityFeed stop-confirm flow.
  const handleStop = useCallback(() => {
    toast.info(`Stopping ${label}...`);
    api
      .stopInstance(name)
      .then(() => toast.success(`${label} stop requested`))
      .catch((err: unknown) =>
        toast.error(
          `Stop failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [name, label, toast]);

  // Delete — routed through ConfirmDialog (destructive); on confirm, removes the
  // line and invalidates the lines query so the table drops the row (same flow
  // as Ops.tsx handleDelete).
  const handleDelete = useCallback(() => {
    api
      .deleteLine(name)
      .then(() => {
        toast.success(`${label} deleted`);
        void queryClient.invalidateQueries({ queryKey: ['lines'] });
      })
      .catch((err: unknown) =>
        toast.error(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [name, label, toast, queryClient]);

  if (!canAct) return null;

  return (
    // The wrapper stops row-activation: a click that lands on the kebab (or its
    // portal-less trigger) must not bubble to the TableRow onActivate (open
    // drawer). Keyboard activation of the trigger is handled by the primitive.
    <span
      className="soup-menu-trigger-cell"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Menu
        label={`Actions for ${label}`}
        triggerLabel={<MoreVertical size={ICON} strokeWidth={1.75} aria-hidden="true" />}
        triggerLabelText={`Actions for ${label}`}
        triggerClassName="soup-menu-trigger--icon"
      >
        <MenuSection label="Line">
          <MenuItem
            icon={<RotateCw size={ICON} strokeWidth={1.75} />}
            onSelect={handleRestart}
          >
            Restart
          </MenuItem>
          <MenuItem
            icon={<Square size={ICON} strokeWidth={1.75} />}
            destructive
            confirmTitle={`Stop ${label}?`}
            confirmBody={
              <>
                Stopping will disconnect <strong>{label}</strong> from its channel.
                The line will not reconnect until manually started.
              </>
            }
            confirmLabel="Stop line"
            onSelect={handleStop}
          >
            Stop
          </MenuItem>
        </MenuSection>
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 size={ICON} strokeWidth={1.75} />}
          destructive
          confirmTitle={`Delete ${label}?`}
          confirmBody={
            <>
              This will stop the process, remove all configuration, data, and
              message history for <strong>{label}</strong>. This cannot be undone.
            </>
          }
          confirmLabel="Delete permanently"
          onSelect={handleDelete}
        >
          Delete line
        </MenuItem>
      </Menu>
    </span>
  );
};

export default FleetRowMenu;
