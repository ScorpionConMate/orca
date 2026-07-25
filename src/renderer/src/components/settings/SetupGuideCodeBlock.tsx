import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type SetupGuideCodeBlockProps = {
  lines: string[]
}

export function SetupGuideCodeBlock({ lines }: SetupGuideCodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = lines.join('\n')
  return (
    <div className="relative">
      <pre className="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted p-3 text-xs leading-relaxed scrollbar-sleek">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-2 right-2"
        aria-label={translate('auto.components.settings.SetupGuideCodeBlock.copyCommands', 'Copy commands')}
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
