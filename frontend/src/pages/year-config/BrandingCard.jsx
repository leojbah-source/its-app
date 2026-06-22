import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';
import FileDrop from '../../components/ui/FileDrop';
import { Loader2 } from 'lucide-react';

export default function BrandingCard({ config, onChange, onUpload, uploadingField }) {
  return (
    <Card
      title="Branding & teacher deadline"
      description="Logos appear on PDFs, registration screens, and the app. The KCA logo and sponsor logo are used in generated result PDFs."
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <AssetSlot
          field="its_logo"
          label="ITS logo"
          accept="image/*"
          hint="Shown on PWA, registration & reports"
          asset={config.assets.its_logo}
          uploading={uploadingField === 'its_logo'}
          onUpload={onUpload}
        />
        <AssetSlot
          field="kca_logo"
          label="KCA logo"
          accept="image/*"
          hint="PNG or SVG, transparent background"
          asset={config.assets.kca_logo}
          uploading={uploadingField === 'kca_logo'}
          onUpload={onUpload}
        />
        <AssetSlot
          field="sponsor_logo"
          label="Title sponsor logo"
          accept="image/*"
          hint="PNG or SVG, transparent background"
          asset={config.assets.sponsor_logo}
          uploading={uploadingField === 'sponsor_logo'}
          onUpload={onUpload}
        />
        <AssetSlot
          field="result_template"
          label="Result PDF template"
          accept=".pdf,.docx"
          hint="PDF or Word, used as the print layout"
          asset={config.assets.result_template}
          uploading={uploadingField === 'result_template'}
          onUpload={onUpload}
        />
      </div>

      <div className="mt-6 max-w-xs">
        <Input
          label="Teacher name deadline"
          type="date"
          value={config.teacher_name_deadline}
          hint="Can be moved later if needed, even after contests conclude."
          onChange={(e) => onChange({ ...config, teacher_name_deadline: e.target.value })}
        />
      </div>
    </Card>
  );
}

function AssetSlot({ field, label, accept, hint, asset, uploading, onUpload }) {
  return (
    <div className="relative">
      <FileDrop
        label={label}
        accept={accept}
        hint={hint}
        currentUrl={asset?.url}
        currentName={asset?.name}
        onFile={(file) => onUpload(field, file)}
        onClear={() => onUpload(field, null)}
      />
      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70">
          <Loader2 size={20} className="animate-spin text-navy-500" />
        </div>
      )}
    </div>
  );
}