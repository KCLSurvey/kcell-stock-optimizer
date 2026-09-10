import { useRef, type DragEvent } from 'react'

interface Props {
  title: string
  description: string
  required?: boolean
  file: File | null
  onChange: (file: File | null) => void
}

export function FileSlot({ title, description, required, file, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFiles(list: FileList | null) {
    const f = list?.[0] ?? null
    if (f && !/\.xlsx?$/i.test(f.name)) {
      onChange(null)
      return
    }
    onChange(f)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`file-slot${file ? ' file-slot--filled' : ''}`}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="file-slot__title">
        {title}
        {required && <span className="file-slot__required"> *</span>}
      </div>
      <div className="file-slot__desc">{description}</div>
      <div className="file-slot__status">
        {file ? (
          <>
            <span className="file-slot__check">✓</span> {file.name}
          </>
        ) : (
          'нажмите или перетащите файл (.xlsx)'
        )}
      </div>
      {file && (
        <button
          type="button"
          className="file-slot__clear"
          onClick={(e) => {
            e.stopPropagation()
            onChange(null)
            if (inputRef.current) inputRef.current.value = ''
          }}
        >
          убрать
        </button>
      )}
    </div>
  )
}
