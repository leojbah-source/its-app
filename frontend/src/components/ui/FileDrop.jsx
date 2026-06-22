import { useRef, useState } from 'react';
import { UploadCloud, FileCheck2, X } from 'lucide-react';

export default function FileDrop({ label, hint, accept, currentUrl, currentName, onFile, onClear }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (files) => {
    if (files && files[0]) onFile(files[0]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-sm font-medium text-navy-800">{label}</span>}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragOver ? 'border-navy-400 bg-navy-50' : 'border-slate-300 hover:border-navy-300 hover:bg-slate-50'
        }`}
      >
        {currentUrl ? (
          <div className="flex items-center gap-2 text-sm text-navy-700">
            {accept?.includes('image') ? (
              <img src={currentUrl} alt={currentName || label} className="h-10 w-10 rounded object-contain" />
            ) : (
              <FileCheck2 size={20} className="text-emerald-500" />
            )}
            <span className="max-w-[12rem] truncate font-medium">{currentName || 'Uploaded file'}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear?.();
              }}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-500"
              aria-label="Remove file"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <UploadCloud size={22} className="text-navy-400" />
            <p className="text-sm text-slate-600">
              <span className="font-medium text-navy-600">Click to upload</span> or drag and drop
            </p>
          </>
        )}
        {hint && <p className="text-xs text-slate-400">{hint}</p>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    </div>
  );
}
