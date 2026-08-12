/**
 * What the Image tab just made, under the form that made it.
 *
 * The library already holds every generated image, but it is a tab away, and
 * seeing the picture is the whole point of pressing Generate. So they are shown
 * here too, at a size worth judging — `object-contain` rather than the library
 * thumbnail's crop, since a portrait image chopped into a 16:9 box tells you
 * very little about the image you paid for.
 */
import { useAssetUrl } from '../hooks/useAssetUrl'
import { Button } from './ui'
import type { Asset } from '../lib/types'

export function ImageResults({
  assets,
  onAdd,
}: {
  assets: Asset[]
  onAdd: (asset: Asset) => void
}) {
  return (
    <ul className="flex flex-col gap-3">
      {assets.map((asset) => (
        <li
          key={asset.id}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2"
        >
          <GeneratedImage asset={asset} />
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-xs text-ink-dim" title={asset.name}>
              {asset.prompt ?? asset.name}
            </p>
            <Button onClick={() => onAdd(asset)} title="Add to the end of the picture track">
              Add to timeline
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function GeneratedImage({ asset }: { asset: Asset }) {
  const url = useAssetUrl(asset)

  return (
    <img
      src={url ?? undefined}
      alt={asset.name}
      className="max-h-80 w-full rounded-lg bg-surface-2 object-contain"
    />
  )
}
