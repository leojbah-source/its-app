import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, Snowflake } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import { Input } from '../components/ui/FormField';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { yearConfigApi, ApiError } from '../api/client';
import { defaultYearConfig, mergeYearConfig } from './year-config/defaults';
import { validateYearConfig } from './year-config/validate';
import AgeGroupsCard from './year-config/AgeGroupsCard';
import GradingCard from './year-config/GradingCard';
import DivergenceCard from './year-config/DivergenceCard';
import BrandingCard from './year-config/BrandingCard';

const CURRENT_YEAR = new Date().getFullYear();

export default function YearConfig() {
  const { token } = useAuth();
  const { showToast } = useToast();

  const [year, setYear] = useState(CURRENT_YEAR);
  const [config, setConfig] = useState(defaultYearConfig(CURRENT_YEAR));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null); // 'publish' | 'freeze' | null

  const loadConfig = useCallback(
    async (targetYear) => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await yearConfigApi.get(token, targetYear);
        setConfig(mergeYearConfig(targetYear, data));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // No config saved yet for this year — start fresh, that's expected.
          setConfig(defaultYearConfig(targetYear));
        } else {
          setLoadError(err.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadConfig(year);
  }, [year, loadConfig]);

  const { errors, warnings } = validateYearConfig(config);
  const hasErrors = Object.keys(errors).length > 0;

  const handleUpload = async (field, file) => {
    if (!file) {
      setConfig((c) => ({ ...c, assets: { ...c.assets, [field]: { url: null, name: null } } }));
      return;
    }
    setUploadingField(field);
    try {
      const result = await yearConfigApi.uploadAsset(token, field, file);
      setConfig((c) => ({
        ...c,
        assets: { ...c.assets, [field]: { url: result.url, name: result.name || file.name } },
      }));
      showToast(`${file.name} uploaded.`, 'success');
    } catch (err) {
      showToast(err.message || 'Upload failed.', 'error');
    } finally {
      setUploadingField(null);
    }
  };

  const persistConfig = async () => {
    await yearConfigApi.update(token, config);
  };

  const handlePublish = async () => {
    setSaving(true);
    try {
      await persistConfig();
      await yearConfigApi.publish(token, config);
      setConfig((c) => ({ ...c, status: 'published' }));
      showToast(`Year ${config.year} configuration published.`, 'success');
      setConfirmAction(null);
    } catch (err) {
      showToast(err.message || 'Could not publish the configuration.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleFreeze = async () => {
    setSaving(true);
    try {
      await yearConfigApi.freezeRegistrations(token);
      setConfig((c) => ({ ...c, registrations_frozen: true }));
      showToast('Registrations are now frozen.', 'success');
      setConfirmAction(null);
    } catch (err) {
      showToast(err.message || 'Could not freeze registrations.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout
      title="Year Setup"
      subtitle="Every annual parameter lives here — nothing about ages, points, or branding is hard-coded."
      actions={
        <>
          <Button
            variant="outline"
            icon={Snowflake}
            disabled={config.registrations_frozen}
            onClick={() => setConfirmAction('freeze')}
          >
            {config.registrations_frozen ? 'Registrations frozen' : 'Freeze Registrations'}
          </Button>
          <Button
            variant="gold"
            icon={ShieldCheck}
            disabled={hasErrors}
            onClick={() => setConfirmAction('publish')}
          >
            Publish Config
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-end gap-4">
              <Input
                label="Contest year"
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || CURRENT_YEAR)}
                className="w-32"
              />
              <Input
                label="Event start date"
                type="date"
                value={config.event_start_date}
                error={errors.event_start_date}
                onChange={(e) => setConfig({ ...config, event_start_date: e.target.value })}
                className="w-44"
              />
              <Input
                label="Event end date"
                type="date"
                value={config.event_end_date}
                error={errors.event_end_date}
                onChange={(e) => setConfig({ ...config, event_end_date: e.target.value })}
                className="w-44"
              />
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={config.status === 'published' ? 'success' : 'neutral'}>
                {config.status === 'published' ? 'Published' : 'Draft'}
              </Badge>
              {config.registrations_frozen && (
                <Badge tone="navy">
                  <Lock size={11} /> Registrations frozen
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {loadError && <ErrorBanner message={loadError} onRetry={() => loadConfig(year)} />}

        {warnings.length > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <ul className="list-inside list-disc space-y-0.5">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {loading ? (
          <PageLoader label={`Loading configuration for ${year}…`} />
        ) : (
          <>
            <AgeGroupsCard
              ageGroups={config.age_groups}
              errors={errors}
              onChange={(age_groups) => setConfig({ ...config, age_groups })}
            />
            <GradingCard config={config} errors={errors} onChange={setConfig} />
            <DivergenceCard config={config} errors={errors} onChange={setConfig} />
            <BrandingCard config={config} onChange={setConfig} onUpload={handleUpload} uploadingField={uploadingField} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction === 'publish'}
        title={`Publish the ${config.year} configuration?`}
        description="This makes the parameters live for registration, judging, and every generated PDF. You can still edit and re-publish later."
        confirmLabel="Publish"
        variant="gold"
        loading={saving}
        onConfirm={handlePublish}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'freeze'}
        title="Freeze registrations?"
        description="No new participants or event additions will be accepted until this is lifted. Existing registrations are unaffected."
        confirmLabel="Freeze registrations"
        variant="danger"
        loading={saving}
        onConfirm={handleFreeze}
        onCancel={() => setConfirmAction(null)}
      />
    </AdminLayout>
  );
}
