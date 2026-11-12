import { lazy, Suspense, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOpenedOnce } from '../../lib/preloaded-component';
import { useAutomationsStore } from '../../stores/automations';
import { automationHref } from './automation-actions';

// The form loads the first time one is opened.
const AutomationFormDialog = lazy(() =>
  import('./AutomationFormDialog').then((m) => ({
    default: m.AutomationFormDialog,
  })),
);

/**
 * The create / edit form, opened from anywhere through the automations
 * store (⌘K, a session's ⋯ menu, the automations page). Mount once.
 */
export function AutomationFormHost() {
  const navigate = useNavigate();
  const request = useAutomationsStore((s) => s.formRequest);
  const closeForm = useAutomationsStore((s) => s.closeForm);
  // Keep the last request's form on screen while the dialog animates out.
  const lastRef = useRef(request);
  if (request) lastRef.current = request;
  const shown = request ?? lastRef.current;
  const automation = useAutomationsStore((s) =>
    shown?.mode === 'edit'
      ? (s.automations.find((item) => item.id === shown.automationId) ?? null)
      : null,
  );
  const opened = useOpenedOnce(!!request);
  if (!opened || !shown) return null;
  // An edit whose automation went away (deleted elsewhere) closes.
  const open = !!request && (request.mode === 'create' || !!automation);

  return (
    <Suspense fallback={null}>
      <AutomationFormDialog
        key={shown.nonce}
        open={open}
        onClose={closeForm}
        automation={automation}
        prefill={shown.mode === 'create' ? shown.prefill : undefined}
        onSaved={(saved) => {
          if (shown.mode === 'create') navigate(automationHref(saved.id));
        }}
      />
    </Suspense>
  );
}
