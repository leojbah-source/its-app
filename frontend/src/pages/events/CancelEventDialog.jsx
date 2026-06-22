import { useState } from 'react';
import { Textarea } from '../../components/ui/FormField';
import ConfirmDialog from '../../components/ui/ConfirmDialog';

export default function CancelEventDialog({ event, loading, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const open = Boolean(event);

  const handleConfirm = () => {
    if (!reason.trim()) return;
    onConfirm(reason.trim());
  };

  return (
    <ConfirmDialog
      open={open}
      title={`Cancel "${event?.event_name}"?`}
      description="Affected participants will get one swap window into another event after the cancellation is published. This is recorded in the audit log."
      confirmLabel="Cancel event"
      variant="danger"
      loading={loading}
      onConfirm={handleConfirm}
      onCancel={() => {
        setReason('');
        onCancel();
      }}
    >
      <Textarea
        label="Reason"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder="e.g. Insufficient registrations, venue conflict…"
      />
    </ConfirmDialog>
  );
}
