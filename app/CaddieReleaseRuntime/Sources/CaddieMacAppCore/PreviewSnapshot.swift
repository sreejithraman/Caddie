import Foundation

public enum AppRunMode: Equatable, Sendable {
    case live
    case preview
}

public struct PreviewSnapshotLoader: Sendable {
    public static let stateFileName = "management-v2.json"
    public static let inventoryFileName = "management-v2.json.inventory-v1.json"

    private static let maximumFileSize = 16 * 1_024 * 1_024

    public init() {}

    public func load(from directory: URL) throws -> AppSnapshot {
        let stateData = try read(Self.stateFileName, from: directory)
        let inventoryData = try read(Self.inventoryFileName, from: directory)
        let decoder = JSONDecoder()
        let state: ManagementState
        let store: InventoryStore
        do {
            state = try decoder.decode(ManagementState.self, from: stateData)
            store = try decoder.decode(InventoryStore.self, from: inventoryData)
        } catch {
            throw PreviewSnapshotFault.invalidFiles
        }
        guard state.version == 2,
              state.revision >= 0,
              let snapshot = state.snapshot,
              snapshot.revision == state.revision,
              store.version == 1,
              let projection = store.projections
                .filter({ $0.revision <= snapshot.revision })
                .max(by: { $0.revision < $1.revision }) else {
            throw PreviewSnapshotFault.incompatibleFiles
        }
        return snapshot.includingInventory(projection.skillInventory, projects: projection.projects)
    }

    private func read(_ name: String, from directory: URL) throws -> Data {
        let file = directory.appendingPathComponent(name, isDirectory: false)
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw PreviewSnapshotFault.missingFile(name)
        }
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maximumFileSize else { throw PreviewSnapshotFault.fileTooLarge(name) }
            return try Data(contentsOf: file, options: [.mappedIfSafe])
        } catch let fault as PreviewSnapshotFault {
            throw fault
        } catch {
            throw PreviewSnapshotFault.cannotRead(name)
        }
    }
}

public enum PreviewSnapshotFault: LocalizedError, Equatable {
    case missingFile(String)
    case cannotRead(String)
    case fileTooLarge(String)
    case invalidFiles
    case incompatibleFiles

    public var errorDescription: String? {
        switch self {
        case .missingFile(let name): "The preview is missing \(name)."
        case .cannotRead(let name): "The preview cannot read \(name)."
        case .fileTooLarge(let name): "The preview file \(name) is too large."
        case .invalidFiles: "The preview files are not valid Caddie data."
        case .incompatibleFiles: "The preview state and inventory do not belong together."
        }
    }
}

private struct ManagementState: Decodable {
    let version: Int
    let revision: Int
    let snapshot: AppSnapshot?
}

private struct InventoryStore: Decodable {
    let version: Int
    let projections: [InventoryProjection]
}

private struct InventoryProjection: Decodable {
    let revision: Int
    let skillInventory: [AppSnapshot.InventorySkill]
    let projects: [AppSnapshot.ProjectInventory]
}
