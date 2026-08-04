import { useAssetUrl } from '../hooks/useAssetUrl'
import type { Asset } from '../lib/types'

export function AssetThumb({
  asset,
  selected,
  onClick,
  className = '',
}: {
  asset: Asset
  selected?: boolean
  onClick?: () => void
  className?: string
}) {
  const url = useAssetUrl(asset)

  const content =
    asset.kind === 'video' ? (
      <video
        src={url ?? undefined}
        muted
        playsInline
        preload="metadata"
        className="size-full object-cover"
      />
    ) : asset.kind === 'audio' ? (
      <span className="flex size-full items-center justify-center text-lg" aria-hidden>
        🎙️
      </span>
    ) : (
      <img src={url ?? undefined} alt={asset.name} className="size-full object-cover" />
    )

  const classes = `relative aspect-video overflow-hidden rounded-lg border bg-surface-2 transition ${
    selected ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-ink-dim'
  } ${className}`

  if (!onClick) {
    return (
      <div className={classes} title={asset.name}>
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={classes}
      title={asset.name}
      aria-pressed={selected}
    >
      {content}
    </button>
  )
}
