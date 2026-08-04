import CoreServices
import Foundation

public struct FileObservation: Equatable, Sendable {
    public let watchIDs: Set<String>
    public let changedPaths: Set<String>
    public let toolStateRoot: String
    public let rootsUncertain: Bool

    public var containsOnlyToolStateChanges: Bool {
        let toolPaths = changedPaths.filter(Self.isToolStatePath)
        guard !toolPaths.isEmpty else { return false }
        let toolParents = Set(toolPaths.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path })
        guard toolParents == Set([toolStateRoot]) else { return false }
        return changedPaths.allSatisfy { Self.isToolStatePath($0) || toolParents.contains($0) }
    }

    private static func isToolStatePath(_ path: String) -> Bool {
        let name = URL(fileURLWithPath: path).lastPathComponent
        return name == "management-v2.json"
            || name == "management-v2.json.lock"
            || name.hasPrefix("management-v2.json.lock.release-")
            || (name.hasPrefix(".management-v2.json.") && name.hasSuffix(".tmp"))
    }
}

public protocol SourceWatching: AnyObject {
    func replaceWatches(_ watches: [AppSnapshot.Watch])
    func stop()
}

public final class FSEventWatcher: SourceWatching, @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.caddie.file-events")
    private let onObservation: @Sendable (FileObservation) -> Void
    private let onFault: @Sendable (String) -> Void
    private let toolStateRoot: String
    private var streams = LiveWatchSwap<FSEventStreamRef>()
    private var watchesByPath: [String: String] = [:]

    public init(
        toolStateRoot: URL,
        onObservation: @escaping @Sendable (FileObservation) -> Void,
        onFault: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.toolStateRoot = toolStateRoot.standardizedFileURL.path
        self.onObservation = onObservation
        self.onFault = onFault
    }

    public func replaceWatches(_ watches: [AppSnapshot.Watch]) {
        queue.async { [weak self] in self?.install(watches) }
    }

    public func stop() {
        queue.sync { tearDownCurrent() }
    }

    deinit { stop() }

    private func install(_ watches: [AppSnapshot.Watch]) {
        guard !watches.isEmpty else { tearDownCurrent(); watchesByPath = [:]; return }
        let context = Unmanaged.passUnretained(self).toOpaque()
        var streamContext = FSEventStreamContext(
            version: 0, info: context, retain: nil, release: nil, copyDescription: nil
        )
        var failure: String?
        let replaced = streams.replace(start: {
            let candidate = FSEventStreamCreate(
                nil,
                { _, info, count, paths, flags, _ in
                    guard let info else { return }
                    let watcher = Unmanaged<FSEventWatcher>.fromOpaque(info).takeUnretainedValue()
                    watcher.consume(count: count, paths: paths, flags: flags)
                },
                &streamContext,
                watches.map(\.path) as CFArray,
                FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                0,
                FSEventStreamCreateFlags(
                    kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes
                        | kFSEventStreamCreateFlagWatchRoot
                )
            )
            guard let candidate else {
                failure = "Caddie could not create its file watch. The prior watch remains active."
                return nil
            }
            FSEventStreamSetDispatchQueue(candidate, queue)
            guard FSEventStreamStart(candidate) else {
                FSEventStreamInvalidate(candidate)
                FSEventStreamRelease(candidate)
                failure = "Caddie could not start its file watch. The prior watch remains active."
                return nil
            }
            return candidate
        }, stop: tearDown)
        if replaced { watchesByPath = Dictionary(uniqueKeysWithValues: watches.map { ($0.path, $0.id) }) }
        else if let failure { onFault(failure) }
    }

    private func consume(count: Int, paths: UnsafeMutableRawPointer, flags: UnsafePointer<FSEventStreamEventFlags>) {
        let values = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
        let uncertainMask = FSEventStreamEventFlags(
            kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped
                | kFSEventStreamEventFlagKernelDropped | kFSEventStreamEventFlagRootChanged
        )
        var ids: Set<String> = []
        var changedPaths: Set<String> = []
        var uncertain = false
        for index in 0..<min(count, values.count) {
            uncertain = uncertain || flags[index] & uncertainMask != 0
            let changed = values[index]
            changedPaths.insert(changed)
            for (root, id) in watchesByPath where changed == root || changed.hasPrefix(root + "/") { ids.insert(id) }
        }
        onObservation(.init(
            watchIDs: ids, changedPaths: changedPaths, toolStateRoot: toolStateRoot, rootsUncertain: uncertain
        ))
    }

    private func tearDownCurrent() {
        streams.remove(stop: tearDown)
    }

    private func tearDown(_ stream: FSEventStreamRef) {
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}

final class LiveWatchSwap<Handle> {
    private(set) var current: Handle?

    @discardableResult
    func replace(start: () -> Handle?, stop: (Handle) -> Void) -> Bool {
        guard let next = start() else { return false }
        let prior = current
        current = next
        if let prior { stop(prior) }
        return true
    }

    func remove(stop: (Handle) -> Void) {
        guard let current else { return }
        self.current = nil
        stop(current)
    }
}
