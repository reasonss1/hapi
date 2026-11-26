import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeCopyToClipboard } from './clipboard'

describe('safeCopyToClipboard', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            writable: true,
            value: vi.fn(() => false)
        })
    })

    it('uses navigator clipboard writeText when available', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(true)

        await safeCopyToClipboard('hello')

        expect(writeText).toHaveBeenCalledWith('hello')
        expect(execCommand).not.toHaveBeenCalled()
    })

    it('starts the clipboard write before its text is available', async () => {
        class TestClipboardItem {
            constructor(readonly values: Record<string, Promise<string>>) {}
        }
        const write = vi.fn(async ([item]: TestClipboardItem[]) => {
            expect(await item.values['text/plain']).toBe('generated command')
        })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
        vi.stubGlobal('ClipboardItem', TestClipboardItem)

        try {
            let supplyText!: (value: string) => void
            const text = new Promise<string>((resolve) => { supplyText = resolve })
            const copying = safeCopyToClipboard(text)

            expect(write).toHaveBeenCalledOnce()
            supplyText('generated command')
            await copying
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('falls back to execCommand when clipboard api write fails', async () => {
        const writeText = vi.fn(async () => {
            throw new Error('clipboard denied')
        })
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(true)

        await safeCopyToClipboard('fallback')

        expect(writeText).toHaveBeenCalledWith('fallback')
        expect(execCommand).toHaveBeenCalledWith('copy')
    })

    it('throws when both modern and legacy copy strategies fail', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: undefined
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(false)

        await expect(safeCopyToClipboard('x')).rejects.toThrow('Copy to clipboard failed')
    })
})
