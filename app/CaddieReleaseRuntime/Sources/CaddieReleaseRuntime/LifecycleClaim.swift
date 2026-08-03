import Darwin
import Foundation

struct LifecycleClaim {
    let directory: URL
    let nonce: UUID
    let fileManager: FileManager

    func release() {
        guard let owner = try? readLifecycleOwner(directory: directory), owner.nonce == nonce else { return }
        try? fileManager.removeItem(at: directory)
    }
}

struct LifecycleOwner: Codable, Equatable {
    let version: Int
    let nonce: UUID
    let processID: Int32
    let createdAt: Date
}

func acquireLifecycleClaim(supportRoot: URL, fileManager: FileManager) throws -> LifecycleClaim {
    let lock = supportRoot.appendingPathComponent("Release Lifecycle.lock", isDirectory: true)
    try fileManager.createDirectory(at: supportRoot, withIntermediateDirectories: true)
    let deadline = Date().addingTimeInterval(15)
    while true {
        if let claim = try publishClaim(at: lock, supportRoot: supportRoot, fileManager: fileManager) { return claim }
        let observed = try readLifecycleOwner(directory: lock)
        if processIsAlive(observed.processID) {
            guard Date() < deadline else { throw ReleaseRuntimeFault.lifecycleClaimBusy }
            usleep(20_000)
            continue
        }
        try takeOverDeadClaim(
            observed: observed,
            lock: lock,
            supportRoot: supportRoot,
            fileManager: fileManager
        )
    }
}

private func takeOverDeadClaim(
    observed: LifecycleOwner,
    lock: URL,
    supportRoot: URL,
    fileManager: FileManager
) throws {
    let gateURL = supportRoot.appendingPathComponent("Release Lifecycle.takeover", isDirectory: true)
    guard let gate = try publishClaim(at: gateURL, supportRoot: supportRoot, fileManager: fileManager) else {
        throw ReleaseRuntimeFault.takeoverClaimPresent
    }
    defer { gate.release() }
    let current = try readLifecycleOwner(directory: lock)
    guard current == observed, !processIsAlive(current.processID) else { return }
    let stale = supportRoot.appendingPathComponent("Release Lifecycle.stale-\(current.nonce.uuidString)")
    do {
        try fileManager.moveItem(at: lock, to: stale)
        try fileManager.removeItem(at: stale)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
        return
    }
}

private func publishClaim(
    at destination: URL,
    supportRoot: URL,
    fileManager: FileManager
) throws -> LifecycleClaim? {
    let nonce = UUID()
    let temporary = supportRoot.appendingPathComponent(".release-claim-\(nonce.uuidString)", isDirectory: true)
    do {
        try fileManager.createDirectory(at: temporary, withIntermediateDirectories: false)
        let owner = LifecycleOwner(version: 1, nonce: nonce, processID: getpid(), createdAt: Date())
        try JSONEncoder.caddie.encode(owner).write(
            to: temporary.appendingPathComponent("owner.json"),
            options: [.atomic, .completeFileProtectionUnlessOpen]
        )
        do {
            try fileManager.moveItem(at: temporary, to: destination)
            return LifecycleClaim(directory: destination, nonce: nonce, fileManager: fileManager)
        } catch let error as CocoaError where error.code == .fileWriteFileExists {
            try? fileManager.removeItem(at: temporary)
            return nil
        }
    } catch {
        try? fileManager.removeItem(at: temporary)
        throw error
    }
}

func readLifecycleOwner(directory: URL) throws -> LifecycleOwner {
    let data: Data
    do { data = try Data(contentsOf: directory.appendingPathComponent("owner.json")) }
    catch { throw ReleaseRuntimeFault.malformedLifecycleClaim }
    do {
        try StrictJSON.validateLifecycleOwner(data)
        let owner = try JSONDecoder.caddie.decode(LifecycleOwner.self, from: data)
        guard owner.version == 1, owner.processID > 0 else { throw ReleaseRuntimeFault.malformedLifecycleClaim }
        return owner
    } catch let fault as ReleaseRuntimeFault { throw fault }
    catch { throw ReleaseRuntimeFault.malformedLifecycleClaim }
}

private func processIsAlive(_ processID: Int32) -> Bool {
    kill(processID, 0) == 0 || errno == EPERM
}

extension JSONEncoder {
    static var caddie: JSONEncoder {
        let value = JSONEncoder()
        value.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        value.dateEncodingStrategy = .iso8601
        return value
    }
}

extension JSONDecoder {
    static var caddie: JSONDecoder {
        let value = JSONDecoder()
        value.dateDecodingStrategy = .iso8601
        return value
    }
}
