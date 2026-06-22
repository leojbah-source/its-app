import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { eventsApi, categoriesApi } from '../api/client';
import EventsTable from './events/EventsTable';
import EventEditDrawer from './events/EventEditDrawer';
import CancelEventDialog from './events/CancelEventDialog';

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.events || [];
}

export default function Events() {
  const { token } = useAuth();
  const { showToast } = useToast();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [categories, setCategories] = useState([]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [saving, setSaving] = useState(false);

  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await eventsApi.list(token);
      setEvents(normalizeList(data));
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    categoriesApi.list(token).then(setCategories).catch(() => {});
  }, [token]);

  const openCreate = () => {
    setEditingEvent(null);
    setDrawerOpen(true);
  };

  const openEdit = (event) => {
    setEditingEvent(event);
    setDrawerOpen(true);
  };

  const handleSave = async (draft) => {
    setSaving(true);
    try {
      if (draft.id) {
        const updated = await eventsApi.update(token, draft.id, draft);
        setEvents((list) => list.map((e) => (e.id === draft.id ? { ...e, ...updated } : e)));
        showToast(`"${draft.event_name}" updated.`, 'success');
      } else {
        const created = await eventsApi.create(token, draft);
        setEvents((list) => [...list, created]);
        showToast(`"${draft.event_name}" added.`, 'success');
      }
      setDrawerOpen(false);
    } catch (err) {
      showToast(err.message || 'Could not save the event.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEvent = async (reason) => {
    setCancelling(true);
    try {
      await eventsApi.cancel(token, cancelTarget.id, reason);
      setEvents((list) =>
        list.map((e) =>
          e.id === cancelTarget.id ? { ...e, is_cancelled: true, cancel_reason: reason } : e,
        ),
      );
      showToast(
        `"${cancelTarget.event_name}" cancelled. A swap window will open for affected participants.`,
        'success',
      );
      setCancelTarget(null);
    } catch (err) {
      showToast(err.message || 'Could not cancel the event.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <AdminLayout
      title="Events"
      subtitle="Individual events across Natya, Sangeeta, Sahitya, Kala, and Add-on categories, plus Team Events — each with up to 6 scoring criteria."
      actions={
        <>
          <Button variant="outline" icon={RefreshCw} onClick={loadEvents}>
            Refresh
          </Button>
          <Button variant="gold" icon={Plus} onClick={openCreate}>
            Add event
          </Button>
        </>
      }
    >
      <Card>
        {loading ? (
          <PageLoader label="Loading events…" />
        ) : loadError ? (
          <ErrorBanner message={loadError} onRetry={loadEvents} />
        ) : (
          <EventsTable events={events} onEdit={openEdit} onCancel={setCancelTarget} />
        )}
      </Card>

      <EventEditDrawer
        open={drawerOpen}
        event={editingEvent}
        saving={saving}
        categories={categories}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSave}
      />

      <CancelEventDialog
        event={cancelTarget}
        loading={cancelling}
        onConfirm={handleCancelEvent}
        onCancel={() => setCancelTarget(null)}
      />
    </AdminLayout>
  );
}
