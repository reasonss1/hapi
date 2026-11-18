/** Device cleanup never grants or revokes a CLI credential. */
export class MachineDeletionError extends Error {
    constructor(
        message: string,
        readonly status: 404 | 409 | 503,
        readonly code: string
    ) {
        super(message)
        this.name = 'MachineDeletionError'
    }
}
