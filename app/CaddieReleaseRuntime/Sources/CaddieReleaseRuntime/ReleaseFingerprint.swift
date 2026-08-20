import Darwin
import CryptoKit
import Foundation

public enum ReleaseFingerprint {
    public static func digest(at url: URL, fileManager: FileManager = .default) throws -> String {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw CocoaError(.fileNoSuchFile)
        }
        if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
            throw ReleaseFingerprintFault.symbolicLink
        }
        if !isDirectory.boolValue {
            return SHA256.hash(data: try Data(contentsOf: url)).hex
        }

        let root = url.standardizedFileURL
        let canonicalRootPath = try root.canonicalPath()
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: []
        ) else { throw CocoaError(.fileReadUnknown) }

        var entries: [(String, UInt8, Data)] = []
        for case let child as URL in enumerator {
            let values = try child.resourceValues(forKeys: Set(keys))
            if values.isSymbolicLink == true {
                throw ReleaseFingerprintFault.symbolicLink
            }
            let childPath = child.path
            let parentPath: String
            if childPath.hasPrefix(canonicalRootPath + "/") {
                parentPath = canonicalRootPath
            } else if childPath.hasPrefix(root.path + "/") {
                parentPath = root.path
            } else {
                throw CocoaError(.fileReadUnknown)
            }
            let relative = String(childPath.dropFirst(parentPath.count + 1))
            if values.isDirectory == true {
                entries.append((relative, 1, Data()))
            } else if values.isRegularFile == true {
                entries.append((relative, 0, try Data(contentsOf: child)))
            }
        }
        var hasher = SHA256()
        for (relative, kind, data) in entries.sorted(by: {
            $0.0.utf8.lexicographicallyPrecedes($1.0.utf8)
        }) {
            hasher.update(data: Data(relative.utf8))
            hasher.update(data: Data([0, kind]))
            hasher.update(data: data)
            hasher.update(data: Data([0]))
        }
        return hasher.finalize().hex
    }
}

enum ReleaseFingerprintFault: Error { case symbolicLink }

private extension URL {
    func canonicalPath() throws -> String {
        guard let resolved = realpath(path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

private extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
