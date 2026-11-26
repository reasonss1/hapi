function copyWithExecCommand(text: string): boolean {
    if (typeof document === 'undefined' || !document.body) {
        return false
    }

    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.padding = '0'
    textarea.style.border = '0'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selection = document.getSelection()
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)

    let copied = false
    try {
        copied = document.execCommand('copy')
    } catch {
        copied = false
    } finally {
        document.body.removeChild(textarea)
        if (selection) {
            selection.removeAllRanges()
            if (previousRange) {
                selection.addRange(previousRange)
            }
        }
        activeElement?.focus()
    }

    return copied
}

export async function safeCopyToClipboard(text: string | Promise<string>): Promise<void> {
    // WebKit requires initiating the clipboard write in the click handler.
    // A ClipboardItem can supply its text after that gesture has completed.
    if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined'
        && typeof navigator !== 'undefined' && navigator.clipboard?.write) {
        try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })])
            return
        } catch {
            // Try copying the resolved text through the other supported APIs.
        }
    }

    const value = typeof text === 'string' ? text : await text
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value)
            return
        } catch {
            // Fall through to legacy copy strategy.
        }
    }

    if (copyWithExecCommand(value)) {
        return
    }

    throw new Error('Copy to clipboard failed')
}
