import Foundation

public final class ReleaseLifecycleReservation: @unchecked Sendable {
    private let lock = NSLock()
    private var claim: LifecycleClaim?

    init(claim: LifecycleClaim) {
        self.claim = claim
    }

    public func release() {
        let owned = lock.withLock {
            defer { claim = nil }
            return claim
        }
        owned?.release()
    }

    deinit { release() }
}
